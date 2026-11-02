import { authorize } from "@/core/policy";
import { getOwner } from "@/core/settings";
import { errorMessage } from "@/core/util";
import * as dev from "@/build/developer";
import { generateCreatives } from "@/studio/creative";
import { brandKitForWorkspace, getBrandKit } from "@/studio/brand";
import { researchDistributors } from "@/global/research";
import { draftOutreach, listOutreach, requestSendApproval, sendApproved } from "@/global/outreach";
import { listLeads } from "@/global/crm";
import { proposeMeeting } from "@/calendar/meetings";
import { deliverReport, generateReport } from "@/reports/report";
import { createCompanyTask, type TaskKind } from "@/integrations/tasks";
import { telegramSend } from "@/integrations/telegram";
import { gmailSend, googleConnected } from "@/integrations/google";
import { applyPolicyInstruction, getEscalationPolicy, saveEscalationPolicy } from "@/speak/escalation";
import { learnSkill } from "@/skills/engine";
import { escapeHtml } from "@/core/util";
import { CapabilityUnavailableError } from "@/ai/types";
import type { StepHandler, StepOutcome } from "./workflow";

const later = (sec: number) => new Date(Date.now() + sec * 1000);
const ws = (sc: Parameters<StepHandler>[0]) => String(sc.params.workspaceId ?? sc.workflow.workspaceId ?? "ws_carpediem");

/** Missing connections/providers block the step (owner fixes it, then "Retry") instead of failing silently. */
function blockedIfMissing(e: unknown): StepOutcome | null {
  if (e instanceof CapabilityUnavailableError) return { status: "blocked", summary: e.explanation };
  const m = errorMessage(e);
  if (/not connected|not configured|Connect .* first|No isolated build environment|No telephony/i.test(m)) return { status: "blocked", summary: m };
  return null;
}

const guard =
  (h: StepHandler): StepHandler =>
  async (sc) => {
    try {
      return await h(sc);
    } catch (e) {
      const b = blockedIfMissing(e);
      if (b) return b;
      throw e;
    }
  };

export const HANDLERS: Record<string, StepHandler> = {
  "build.plan": guard(async (sc) => {
    const p = await dev.planProject(sc.ctx, {
      request: String(sc.params.request ?? sc.workflow.request ?? sc.workflow.goal),
      workspaceId: ws(sc),
      kind: sc.params.kind as never,
      locales: sc.params.locales as string[] | undefined,
      productId: (sc.params.productId as string) ?? undefined,
    });
    return { status: "done", result: { projectId: p.id }, summary: `${p.name} · ${p.spec.locales.join(", ")} · sections: ${p.spec.sections.join(", ")}${p.notes.length ? ` · ${p.notes.join(" ")}` : ""}` };
  }),
  "build.content": guard(async (sc) => {
    const p = await dev.writeContent(sc.ctx, String(sc.params.projectId), { market: sc.params.market as string | undefined });
    const review = p.translationReview.map((r) => `${r.locale}: ${r.reasons.join("; ")}`).join(" | ");
    return { status: "done", result: { projectId: p.id, compliance: p.compliance?.status }, summary: `Copy written for ${Object.keys(p.content).join(", ")} · compliance: ${p.compliance?.status}${p.compliance?.issues.length ? ` (${p.compliance.issues.length} item(s) to review)` : ""}${review ? ` · translation review: ${review}` : ""}` };
  }),
  "build.files": guard(async (sc) => {
    const p = await dev.generateFiles(sc.ctx, String(sc.params.projectId));
    const files = await dev.getFiles(sc.ctx, p.id, p.revision);
    return { status: "done", result: { projectId: p.id, revision: p.revision }, summary: `Generated ${files.length} files (Next.js + TypeScript), revision ${p.revision}` };
  }),
  "build.checks": guard(async (sc) => {
    const p = await dev.runChecks(sc.ctx, String(sc.params.projectId));
    const last = p.checks.at(-1)!;
    const steps = last.steps.map((s) => `${s.name} ${s.ok ? "✓" : "✗"}`).join(" · ");
    if (!last.ok) {
      const blocked = last.scan.filter((f) => f.severity === "block");
      throw Object.assign(new Error(blocked.length ? `Security scan blocked: ${blocked.map((b) => b.detail).join("; ")}` : `Checks failed (${steps}): ${last.steps.find((s) => !s.ok)?.output.slice(-400)}`), { permanent: true });
    }
    return { status: "done", result: { projectId: p.id, revision: p.revision }, summary: `Sandbox (${last.sandbox}): ${steps}${p.repairs.length ? ` · ${p.repairs.length} automatic repair(s)` : ""}` };
  }),
  "build.github": guard(async (sc) => {
    const p = await dev.publishToGithub(sc.ctx, String(sc.params.projectId), `workflow:${sc.workflow.id}`);
    return { status: "done", result: { projectId: p.id, prUrl: p.repo?.prUrl ?? "" }, summary: p.repo ? `Committed ${p.repo.commitSha?.slice(0, 7)} → ${p.repo.owner}/${p.repo.name}@${p.repo.branch} · PR: ${p.repo.prUrl}` : "GitHub not connected — code kept in BINGO (connect GitHub to version it)" };
  }),
  "build.preview": guard(async (sc) => {
    const projectId = String(sc.params.projectId);
    const depId = sc.step.state?.deploymentId as string | undefined;
    if (!depId) {
      const p = await dev.deployPreview(sc.ctx, projectId, `workflow:${sc.workflow.id}`);
      const d = p.deployments.at(-1)!;
      return { status: "waiting", resumeAt: later(20), state: { deploymentId: d.id }, summary: `Vercel preview building: ${d.url}` };
    }
    const r = await dev.pollDeployment(sc.ctx, projectId, depId);
    const d = r.project.deployments.find((x) => x.id === depId)!;
    if (r.state === "pending") return { status: "waiting", resumeAt: later(20), summary: `Vercel preview ${d.state.toLowerCase()}: ${d.url}` };
    if (r.state === "error") throw new Error(`Vercel build failed: ${d.logsTail?.slice(-5).join(" ") ?? ""}`);
    const owner = await getOwner(sc.ctx);
    const msg = `🔎 <b>Preview ready</b>: ${escapeHtml(r.project.name)}\n${d.url}${d.verified && !d.verified.ok ? `\n⚠ ${escapeHtml(d.verified.detail)}` : ""}`;
    await telegramSend(sc.ctx, msg).catch(() => undefined);
    if (owner.email && (await googleConnected(sc.ctx))) await gmailSend(sc.ctx, { to: [owner.email], subject: `Preview ready: ${r.project.name}`, text: `${d.url}\n\nApprove production in BINGO: ${sc.ctx.env.publicUrl}/build/${projectId}` }).catch(() => undefined);
    const { emitEvent } = await import("@/skills/engine");
    await emitEvent(sc.ctx, "deployment.preview.ready", { projectId, project: r.project.name, url: d.url, summary: `Preview ready: ${r.project.name} ${d.url}` });
    return { status: "done", result: { projectId, previewUrl: d.url, deploymentId: d.id }, summary: `Preview ready: ${d.url}${d.verified ? ` · verification: ${d.verified.ok ? "passed" : d.verified.detail}` : ""}` };
  }),
  "build.production": guard(async (sc) => {
    const projectId = String(sc.params.projectId);
    const depId = sc.step.state?.deploymentId as string | undefined;
    if (!depId) {
      const r = await dev.requestProduction(sc.ctx, projectId, { approvalId: sc.step.approvalId, requestedBy: `workflow:${sc.workflow.id}`, workflowId: sc.workflow.id, stepId: sc.step.id });
      if (r.status === "awaiting_approval") return { status: "needs_approval", approvalId: r.approvalId!, summary: "Waiting for your approval to publish to production" };
      if (r.status === "blocked") return { status: "blocked", summary: r.reason ?? "Blocked" };
      const d = r.project.deployments.at(-1)!;
      return { status: "waiting", resumeAt: later(20), state: { deploymentId: d.id }, summary: `Production deployment building: ${d.url}` };
    }
    const r = await dev.pollDeployment(sc.ctx, projectId, depId);
    if (r.state === "pending") return { status: "waiting", resumeAt: later(20), summary: "Production deployment building" };
    if (r.state === "error" || r.project.status !== "live") throw Object.assign(new Error(`Production deployment did not verify: ${r.project.deployments.find((x) => x.id === depId)?.verified?.detail ?? "build error"}`), { permanent: true });
    const { emitEvent } = await import("@/skills/engine");
    await emitEvent(sc.ctx, "deployment.production.live", { projectId, project: r.project.name, url: r.project.liveUrl ?? "", summary: `Live: ${r.project.name} ${r.project.liveUrl}` });
    return { status: "done", result: { projectId, liveUrl: r.project.liveUrl }, summary: `Live and verified: ${r.project.liveUrl}` };
  }),

  "studio.generate": guard(async (sc) => {
    const workspaceId = ws(sc);
    const kit = sc.params.brandKitId ? await getBrandKit(sc.ctx, String(sc.params.brandKitId)) : await brandKitForWorkspace(sc.ctx, workspaceId);
    if (!kit) return { status: "blocked", summary: "No brand kit for this workspace" };
    const productName = String(sc.params.productName ?? "").toLowerCase();
    const productId = (sc.params.productId as string) ?? kit.products.find((p) => productName && p.name.toLowerCase() === productName)?.id ?? null;
    const r = await generateCreatives(sc.ctx, {
      workspaceId,
      brandKitId: kit.id,
      productId,
      brief: String(sc.params.brief ?? sc.workflow.goal),
      count: Number(sc.params.count ?? 3),
      formats: (sc.params.formats as string[]) ?? ["instagram-square", "instagram-portrait", "web-hero"],
      language: sc.params.language as string | undefined,
      market: sc.params.market as string | undefined,
    }, `workflow:${sc.workflow.id}`);
    return { status: "done", result: { creativeIds: r.creatives.map((c) => c.id) }, summary: `${r.creatives.length} creative concepts ready for review${r.notes.length ? ` · ${r.notes.join(" ")}` : ""}` };
  }),

  "global.research": guard(async (sc) => {
    const r = await researchDistributors(sc.ctx, { workspaceId: ws(sc), country: String(sc.params.country), count: Number(sc.params.count ?? 20), segment: String(sc.params.segment ?? "pharmaceutical distributors") }, `workflow:${sc.workflow.id}`);
    return {
      status: "done",
      result: { leadIds: r.created.map((l) => l.id), duplicateIds: r.duplicates.map((d) => d.existingId) },
      summary: `${r.created.length} new leads saved (${r.created.filter((l) => l.verification.status === "verified").length} verified on official websites), ${r.duplicates.length} duplicates skipped, ${r.rejected.length} rejected · ${r.sources} sources${r.notes.length ? ` · ${r.notes.join(" ")}` : ""}`,
    };
  }),
  "global.draft": guard(async (sc) => {
    const ids = [...((sc.params.leadIds as string[]) ?? [])];
    const r = await draftOutreach(sc.ctx, { leadIds: ids, language: sc.params.language as string | undefined, kind: (sc.params.kind as never) ?? "initial", purpose: sc.params.purpose as string | undefined, extra: sc.params.extra as string | undefined, workflowId: sc.workflow.id });
    const blocked = r.drafted.filter((d) => d.status === "blocked").length;
    return { status: "done", result: { messageIds: r.drafted.filter((d) => d.status !== "blocked").map((d) => d.id) }, summary: `${r.drafted.length} personalised drafts (${[...new Set(r.drafted.map((d) => d.language))].join(", ") || "—"})${blocked ? `, ${blocked} blocked by compliance` : ""}${r.skipped.length ? `, ${r.skipped.length} skipped (${[...new Set(r.skipped.map((s) => s.reason))].join("; ")})` : ""}` };
  }),
  "global.share_page": guard(async (sc) => {
    const p = await dev.getProject(sc.ctx, String(sc.params.projectId));
    if (!p?.liveUrl) return { status: "blocked", summary: "The page is not live yet." };
    let leadIds = (sc.params.leadIds as string[]) ?? [];
    if (!leadIds.length) leadIds = (await listLeads(sc.ctx, { workspaceId: p.workspaceId })).filter((l) => ["Qualified", "Replied", "Contacted", "Meeting Proposed", "Meeting Confirmed"].includes(l.stage) && !l.optedOut).map((l) => l.id);
    const r = await draftOutreach(sc.ctx, { leadIds, kind: "share_page", language: sc.params.language as string | undefined, purpose: `share our new page ${p.liveUrl}`, extra: `Include this link exactly once: ${p.liveUrl}`, workflowId: sc.workflow.id });
    return { status: "done", result: { messageIds: r.drafted.filter((d) => d.status !== "blocked").map((d) => d.id) }, summary: `${r.drafted.length} emails drafted with ${p.liveUrl}` };
  }),
  "global.send": guard(async (sc) => {
    const ids = (sc.params.messageIds as string[]) ?? [];
    if (!ids.length) return { status: "done", result: { sent: 0 }, summary: "Nothing to send" };
    const state = sc.step.state ?? {};
    if (!state.approved) {
      const r = await requestSendApproval(sc.ctx, ids, { approvalId: sc.step.approvalId, workflowId: sc.workflow.id, stepId: sc.step.id });
      if (r.status === "awaiting_approval") return { status: "needs_approval", approvalId: r.approvalId!, summary: `Waiting for your approval to send ${ids.length} email(s)` };
      if (r.status === "blocked") return { status: "blocked", summary: r.reason ?? "Blocked by policy" };
    }
    const rep = await sendApproved(sc.ctx, ids);
    const all = (await listOutreach(sc.ctx)).filter((m) => ids.includes(m.id));
    const remaining = all.filter((m) => m.status === "approved").length;
    const summary = `Submitted to Gmail: ${all.filter((m) => m.status === "sent").length}/${ids.length}${rep.failed.length ? ` · failed: ${rep.failed.length} (${rep.failed[0]!.error})` : ""}${all.filter((m) => m.status === "suppressed").length ? ` · suppressed: ${all.filter((m) => m.status === "suppressed").length}` : ""}${remaining ? ` · ${remaining} waiting for sending limits` : ""}`;
    if (remaining) return { status: "waiting", resumeAt: later(rep.deferred.some((d) => /Daily/.test(d.reason)) ? 3600 : 60), state: { approved: true }, summary };
    return { status: "done", result: { sent: all.filter((m) => m.status === "sent").map((m) => ({ id: m.id, gmailId: m.gmail?.id, threadId: m.gmail?.threadId })) }, summary };
  }),

  "calendar.propose": guard(async (sc) => {
    let ids = (sc.params.leadIds as string[]) ?? [];
    if (!ids.length) {
      const inbound = await sc.ctx.store.list<{ leadId: string; sentiment: string; intent: string }>("inbound");
      const positive = new Set(inbound.filter((i) => i.sentiment === "positive" || ["interested", "meeting_request"].includes(i.intent)).map((i) => i.leadId));
      ids = (await listLeads(sc.ctx)).filter((l) => positive.has(l.id) && !l.optedOut && ["Replied", "Contacted", "Meeting Proposed"].includes(l.stage)).map((l) => l.id);
    }
    const done: string[] = [];
    const messageIds: string[] = [];
    const problems: string[] = [];
    for (const id of ids) {
      try {
        const r = await proposeMeeting(sc.ctx, { leadId: id, objective: String(sc.params.objective ?? "Introductory call about distribution partnership"), durationMin: Number(sc.params.durationMin ?? 30), workflowId: sc.workflow.id });
        done.push(r.meeting.id);
        if (r.draft) messageIds.push(r.draft.id);
      } catch (e) {
        if (blockedIfMissing(e)) throw e;
        problems.push(errorMessage(e));
      }
    }
    return { status: "done", result: { meetingIds: done, messageIds }, summary: ids.length ? `Proposed times to ${done.length} contact(s) across their time zones${problems.length ? ` · ${problems.join("; ")}` : ""}` : "No positive replies to schedule yet" };
  }),

  "report.generate": guard(async (sc) => {
    const r = await generateReport(sc.ctx, { title: sc.params.title as string | undefined, topic: String(sc.params.topic), country: sc.params.country as string | undefined, language: String(sc.params.language ?? "en"), workspaceId: ws(sc) });
    return { status: "done", result: { reportId: r.id }, summary: `“${r.title}” · ${r.sources.length} sources · ${r.pdfB64 ? "PDF" : "HTML"}${r.pdfNote ? ` (${r.pdfNote})` : ""}` };
  }),
  "report.deliver": guard(async (sc) => {
    const d = await deliverReport(sc.ctx, String(sc.params.reportId), (sc.params.channels as ("email" | "telegram")[]) ?? ["email", "telegram"]);
    const failed = d.filter((x) => !x.ok);
    if (failed.length === d.length) throw new Error(failed.map((f) => `${f.channel}: ${f.detail}`).join("; "));
    return { status: "done", result: { deliveries: d }, summary: d.map((x) => `${x.channel}: ${x.ok ? x.detail : `✗ ${x.detail}`}`).join(" · ") };
  }),

  "notify.telegram": guard(async (sc) => {
    const auth = await authorize(sc.ctx, { kind: "telegram.notify.owner", payload: { wf: sc.workflow.id, step: sc.step.id }, title: "Telegram to you", summary: String(sc.params.text).slice(0, 200), requestedBy: `workflow:${sc.workflow.id}` });
    if (!auth.allowed) return { status: "blocked", summary: auth.reason };
    const r = await telegramSend(sc.ctx, escapeHtml(String(sc.params.text)));
    if (!("messageId" in r)) return { status: "blocked", summary: r.skipped };
    return { status: "done", result: { messageId: r.messageId }, summary: `Telegram message ${r.messageId} sent` };
  }),
  "notify.email": guard(async (sc) => {
    const owner = await getOwner(sc.ctx);
    if (!owner.email) return { status: "blocked", summary: "Set your email in Settings" };
    const auth = await authorize(sc.ctx, { kind: "email.send.owner", payload: { wf: sc.workflow.id, step: sc.step.id }, title: "Email to you", summary: String(sc.params.subject), requestedBy: `workflow:${sc.workflow.id}` });
    if (!auth.allowed) return { status: "blocked", summary: auth.reason };
    const r = await gmailSend(sc.ctx, { to: [owner.email], subject: String(sc.params.subject), text: String(sc.params.text) });
    return { status: "done", result: { gmailId: r.id }, summary: `Email submitted to Gmail (${r.id})` };
  }),
  "tasks.create": guard(async (sc) => {
    const r = await createCompanyTask(sc.ctx, {
      ref: String(sc.params.ref ?? `${sc.workflow.id}:${sc.step.id}`),
      kind: (sc.params.kind as TaskKind) ?? "general",
      title: String(sc.params.title),
      details: String(sc.params.details ?? sc.workflow.goal),
      to: sc.params.to as string | undefined,
      level: sc.params.level as 1 | 2 | 3 | undefined,
      deadline: sc.params.deadlineDays ? new Date(Date.now() + Number(sc.params.deadlineDays) * 864e5) : undefined,
    }, `workflow:${sc.workflow.id}`, sc.workflow.workspaceId);
    if (r.status !== "created" && r.status !== "exists") {
      if (r.status === "error") throw new Error(r.message);
      return { status: "blocked", summary: r.message };
    }
    return { status: "done", result: { taskId: r.taskId, to: r.to }, summary: r.status === "exists" ? `Task already existed: ${r.taskId}` : `Task ${r.taskId} created for ${r.to}` };
  }),
  "speak.policy": guard(async (sc) => {
    const cur = await getEscalationPolicy(sc.ctx);
    const { policy, changes } = applyPolicyInstruction(cur, String(sc.params.instruction), sc.ctx.now());
    if (!changes.length) return { status: "blocked", summary: "I could not map that to an escalation rule. Edit the policy directly in BINGO SPEAK." };
    await saveEscalationPolicy(sc.ctx, policy);
    return { status: "done", result: { changes }, summary: `Escalation policy updated: ${changes.join("; ")}` };
  }),
  "skills.learn": guard(async (sc) => {
    const s = await learnSkill(sc.ctx, String(sc.params.instruction), `workflow:${sc.workflow.id}`);
    if (!s.validation.ok) return { status: "blocked", summary: `Skill saved as draft: ${s.validation.errors.join("; ")}` };
    return { status: "done", result: { skillId: s.id }, summary: `Saved skill “${s.name}” (v${s.version})${s.effect.note ? ` — ${s.effect.note}` : ""}` };
  }),
};

// Permanent failures (checks failed, verification failed) should not be retried blindly.
for (const [k, h] of Object.entries(HANDLERS)) {
  HANDLERS[k] = async (sc) => {
    try {
      return await h(sc);
    } catch (e) {
      if ((e as { permanent?: boolean }).permanent) sc.step.attempts = 99;
      throw e;
    }
  };
}
