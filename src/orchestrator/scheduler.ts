import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { isSuspended } from "@/core/policy";
import { getOwner } from "@/core/settings";
import { errorMessage } from "@/core/util";
import { pollReplies } from "@/global/inbox";
import { pullLeadEdits } from "@/global/crm";
import { sendApproved } from "@/global/outreach";
import { meetingReminders, processSchedulingQueue, refreshMeetingStatuses } from "@/calendar/meetings";
import { followUpIncidents } from "@/speak/escalation";
import { deliverReport, generateReport, templateDue, type ReportTemplate } from "@/reports/report";
import { runWorkflows } from "./workflow";

/**
 * The 24/7 heartbeat. Called every minute by Vercel Cron (/api/cron/tick) or by
 * the standalone worker. Each job has its own interval and records its last run,
 * so a missed tick simply catches up on the next one.
 */
interface JobState {
  id: string;
  lastRunAt: string;
  lastResult: string;
  ok: boolean;
  runs: number;
}

const JOBS: { id: string; everySec: number; run: (ctx: Ctx) => Promise<string> }[] = [
  { id: "workflows", everySec: 0, run: async (ctx) => JSON.stringify(await runWorkflows(ctx, 40_000)) },
  { id: "incident-followups", everySec: 60, run: async (ctx) => `${(await followUpIncidents(ctx)).length} followed up` },
  { id: "outbox", everySec: 120, run: async (ctx) => {
    const r = await sendApproved(ctx);
    return `sent ${r.sent.length}, deferred ${r.deferred.length}, failed ${r.failed.length}`;
  } },
  { id: "inbox", everySec: 600, run: async (ctx) => {
    const r = await pollReplies(ctx);
    return `checked ${r.checked} threads, ${r.processed} new replies${r.errors.length ? `, errors: ${r.errors.slice(0, 2).join("; ")}` : ""}`;
  } },
  { id: "scheduling", everySec: 300, run: async (ctx) => {
    await processSchedulingQueue(ctx);
    return "ok";
  } },
  { id: "meeting-status", everySec: 900, run: async (ctx) => `${(await refreshMeetingStatuses(ctx)).length} changed` },
  { id: "meeting-reminders", everySec: 300, run: async (ctx) => {
    await meetingReminders(ctx);
    return "ok";
  } },
  { id: "sheet-pull", everySec: 1800, run: async (ctx) => `${await pullLeadEdits(ctx)} leads updated from Google Sheets` },
  { id: "recurring-reports", everySec: 900, run: async (ctx) => {
    const owner = await getOwner(ctx);
    const templates = await ctx.store.list<ReportTemplate>("report_templates");
    let n = 0;
    for (const t of templates) {
      if (!templateDue(t, ctx.now(), owner.timezone)) continue;
      await ctx.store.put("report_templates", { ...t, lastRunAt: ctx.now().toISOString() });
      const r = await generateReport(ctx, { title: t.name, topic: t.topic, country: t.country, language: t.language });
      await deliverReport(ctx, r.id, t.channels);
      n++;
    }
    return `${n} recurring report(s)`;
  } },
];

export async function tick(ctx: Ctx, opts: { only?: string[] } = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await ctx.store.put("heartbeat", { id: "last", at: ctx.now().toISOString() });
  if (await isSuspended(ctx)) return { suspended: "Emergency stop is active — no automations ran." };
  for (const job of JOBS) {
    if (opts.only && !opts.only.includes(job.id)) continue;
    const st = await ctx.store.get<JobState>("jobs", job.id);
    if (st && ctx.now().getTime() - new Date(st.lastRunAt).getTime() < job.everySec * 1000) continue;
    let result: string;
    let ok = true;
    try {
      result = await job.run(ctx);
    } catch (e) {
      ok = false;
      result = errorMessage(e);
      await logActivity(ctx, { actor: "scheduler", action: `job.${job.id}.error`, summary: `${job.id}: ${result}`, level: "error" });
    }
    out[job.id] = result;
    await ctx.store.put("jobs", { id: job.id, lastRunAt: ctx.now().toISOString(), lastResult: result.slice(0, 500), ok, runs: (st?.runs ?? 0) + 1 } satisfies JobState);
  }
  return out;
}

export async function jobStatus(ctx: Ctx) {
  const jobs = await ctx.store.list<JobState>("jobs");
  const hb = await ctx.store.get<{ id: string; at: string }>("heartbeat", "last");
  return { heartbeat: hb?.at ?? null, jobs };
}
