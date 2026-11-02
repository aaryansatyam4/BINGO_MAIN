import { z } from "zod";
import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { callJson } from "@/ai/engine";
import { getOwner } from "@/core/settings";
import { errorMessage, normalizeDomain } from "@/core/util";
import { gmailThread, googleConnected, type GmailMessage } from "@/integrations/google";
import { createCompanyTask } from "@/integrations/tasks";
import { detectLanguage } from "@/lang/detect";
import { translateText } from "@/lang/translate";
import { UNTRUSTED_SYSTEM_RULES, wrapUntrusted } from "@/security/untrusted";
import { link, upsertNode } from "@/core/graph";
import { listLeads, saveLead, setStage, suppress, syncLeadsToSheet, type Lead } from "./crm";
import { draftOutreach, messageHash } from "./outreach";

/**
 * Reply monitoring. Inbound emails are untrusted: they are sanitised, analysed
 * into a fixed JSON shape, and every resulting action is chosen by this code.
 */
export const INTENTS = ["interested", "meeting_request", "question", "documents_request", "pricing_request", "exclusivity_request", "not_interested", "unsubscribe", "out_of_office", "other"] as const;
export type Intent = (typeof INTENTS)[number];

const AnalysisSchema = z.object({
  intent: z.enum(INTENTS),
  summary: z.string(),
  requests: z.array(z.string()),
  proposedTimes: z.array(z.string()),
  sentiment: z.enum(["positive", "neutral", "negative"]),
});

export interface InboundMessage {
  id: string; // gmail message id
  leadId: string;
  workspaceId: string;
  threadId: string;
  from: string;
  subject: string;
  original: string;
  language: string;
  languageConfidence: number;
  translation: string | null;
  translationNeedsReview: boolean;
  intent: Intent;
  summary: string;
  requests: string[];
  proposedTimes: string[];
  sentiment: "positive" | "neutral" | "negative";
  suspicious: boolean;
  receivedAt: string;
  actions: string[];
}

const OPT_OUT = [
  /\bunsubscribe\b/i,
  /\b(stop|remove me|do not (contact|email)|don't (contact|email))\b/i,
  /отпис(ать|аться|ка|ыва)|отпиш(и|ите)|не пиши(те)?|больше не (пишите|присылайте)|удалите (меня|нас)/i,
  /obunani bekor|yozmang/i,
  /désabonner|ne plus (me|nous) contacter/i,
  /darse de baja|no (me|nos) contacten/i,
  /abmelden|keine weiteren e-?mails/i,
  /إلغاء الاشتراك|لا تراسلني/,
  /अनसब्सक्राइब|संपर्क न करें/,
];

export function isOptOut(text: string): boolean {
  const firstPart = text.split(/\n>|\nOn .* wrote:|\n-{2,}\s*Original/i)[0] ?? text;
  return OPT_OUT.some((re) => re.test(firstPart));
}

/** Strips quoted history so analysis only sees the new reply. */
export function latestReplyText(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    if (/^>/.test(l) || /^On .+ wrote:$/.test(l.trim()) || /^-{2,}\s*(Original|Исходное)/i.test(l) || /^(From|От):\s/.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim() || text.trim();
}

export async function processInboundMessage(ctx: Ctx, lead: Lead, msg: GmailMessage): Promise<InboundMessage | null> {
  if (await ctx.store.get("inbound", msg.id)) return null;
  const owner = await getOwner(ctx);
  const text = latestReplyText(msg.text);
  const det = detectLanguage(text);
  const actions: string[] = [];
  const wrapped = wrapUntrusted(`email from ${msg.from}`, text);

  let translation: string | null = null;
  let translationNeedsReview = false;
  if (det.language !== "und" && det.language.split("-")[0] !== owner.preferredLanguage.split("-")[0]) {
    try {
      const t = await translateText(ctx, text, owner.preferredLanguage, { workspaceId: lead.workspaceId, glossary: { keep: [lead.company] }, purpose: "inbox.translate" });
      translation = t.translated;
      translationNeedsReview = t.needsReview;
    } catch (e) {
      translation = null;
      actions.push(`translation failed: ${errorMessage(e)}`);
    }
  }

  let analysis: z.infer<typeof AnalysisSchema>;
  if (isOptOut(text)) analysis = { intent: "unsubscribe", summary: "Asked not to be contacted again.", requests: [], proposedTimes: [], sentiment: "negative" };
  else {
    try {
      analysis = (
        await callJson(
          ctx,
          {
            capability: "classification",
            system: `You analyse replies from potential distributors for a pharmaceutical/nutraceutical exporter. Classify the intent and summarise in ${owner.preferredLanguage}. proposedTimes: copy any dates/times the sender proposes exactly as written, with their timezone if stated. ${UNTRUSTED_SYSTEM_RULES}`,
            prompt: `Company: ${lead.company} (${lead.country}). Reply:\n${wrapped.block}`,
          },
          AnalysisSchema,
          { workspaceId: lead.workspaceId, purpose: "inbox.classify" },
        )
      ).data;
    } catch (e) {
      analysis = { intent: "other", summary: `Could not analyse automatically (${errorMessage(e)}). Please read the message.`, requests: [], proposedTimes: [], sentiment: "neutral" };
    }
  }

  const rec: InboundMessage = {
    id: msg.id,
    leadId: lead.id,
    workspaceId: lead.workspaceId,
    threadId: msg.threadId,
    from: msg.from,
    subject: msg.subject,
    original: msg.text.slice(0, 50_000),
    language: det.language,
    languageConfidence: det.confidence,
    translation,
    translationNeedsReview,
    intent: analysis.intent,
    summary: analysis.summary,
    requests: analysis.requests,
    proposedTimes: analysis.proposedTimes,
    sentiment: analysis.sentiment,
    suspicious: wrapped.suspicious,
    receivedAt: new Date(Number(msg.internalDate) || Date.now()).toISOString(),
    actions,
  };

  // Deterministic actions per intent.
  let current = lead;
  if (det.confidence >= 0.6 && det.language !== "und" && current.languageSource !== "manual" && current.language !== det.language) {
    current = { ...current, language: det.language, languageSource: "detected" };
    actions.push(`preferred language set to ${det.language}`);
  }
  current = { ...current, lastContactAt: rec.receivedAt };
  await saveLead(ctx, current);
  await upsertNode(ctx, { id: `message:${msg.id}`, kind: "message", label: msg.subject, data: { direction: "in", intent: rec.intent, at: rec.receivedAt } });
  await link(ctx, `company:${lead.id}`, "sent", `message:${msg.id}`);

  switch (rec.intent) {
    case "unsubscribe": {
      const addr = msg.from.match(/<([^>]+)>/)?.[1] ?? msg.from;
      await suppress(ctx, addr, "Asked to unsubscribe");
      await setStage(ctx, current, "Opted Out", "bingo", "reply asked to stop");
      actions.push("opted out and suppressed — no further emails");
      break;
    }
    case "not_interested":
      await setStage(ctx, current, "Not Interested", "bingo");
      actions.push("marked not interested");
      break;
    case "out_of_office":
      actions.push("auto-reply ignored");
      break;
    case "meeting_request":
      current = await setStage(ctx, current, "Replied", "bingo");
      actions.push("meeting requested — scheduling will propose slots");
      await ctx.store.put("scheduling_queue", { id: lead.id, leadId: lead.id, inboundId: msg.id, proposedTimes: rec.proposedTimes, at: ctx.now().toISOString() });
      break;
    case "exclusivity_request":
    case "pricing_request": {
      current = await setStage(ctx, current, "Replied", "bingo");
      const { escalate } = await import("@/speak/escalation");
      await escalate(ctx, {
        workspaceId: lead.workspaceId,
        category: rec.intent,
        title: `${lead.company} (${lead.country}) requests ${rec.intent === "exclusivity_request" ? "exclusive distribution" : "commercial terms"}`,
        summary: rec.summary,
        details: [`From: ${msg.from}`, `Requests: ${rec.requests.join("; ") || "—"}`, translation ? `Translation: ${translation.slice(0, 1200)}` : `Message: ${text.slice(0, 1200)}`].join("\n"),
        options: rec.intent === "exclusivity_request"
          ? [{ label: "Decline politely", description: "Thank them and explain exclusivity is not offered at this stage." }, { label: "Discuss on a call", description: "Offer a call to understand volumes and market plan before any commitment." }, { label: "Consider limited exclusivity", description: "Only after you set terms (territory, targets, duration)." }]
          : [{ label: "Send approved price list", description: "Only if an approved price list exists." }, { label: "Ask qualifying questions first", description: "Volumes, channels and registration plans." }],
        recommendation: rec.intent === "exclusivity_request" ? "Do not commit. Offer a call to understand their plan; decide terms yourself." : "Ask qualifying questions; share prices only from an approved list.",
        source: { kind: "inbound", id: msg.id },
        verified: true,
        counterparty: { company: lead.company, email: msg.from, domain: normalizeDomain(msg.from) },
      });
      actions.push("escalated to you — BINGO will not commit");
      break;
    }
    case "documents_request": {
      current = await setStage(ctx, current, "Replied", "bingo");
      const r = await createCompanyTask(ctx, {
        ref: `inbound:${msg.id}:docs`,
        kind: "documentation_request",
        title: `Documents requested by ${lead.company} (${lead.country})`,
        details: `${rec.summary}\nRequests: ${rec.requests.join("; ")}\nReply in BINGO → Global → ${lead.company}.`,
        deadline: new Date(ctx.now().getTime() + 2 * 864e5),
        level: 2,
      }, "bingo", lead.workspaceId);
      actions.push(`documentation task: ${r.status}${"taskId" in r ? ` ${r.taskId}` : ""}`);
      break;
    }
    default:
      current = await setStage(ctx, current, "Replied", "bingo");
  }

  // A reply on a lead with a pending meeting proposal goes to the scheduler, whatever the wording.
  const openMeeting = (await ctx.store.list<{ id: string; leadId?: string; status: string }>("meetings", { where: { leadId: lead.id } })).find((m) => m.status === "awaiting_reply" || m.status === "proposed");
  if (openMeeting && !["unsubscribe", "not_interested", "out_of_office"].includes(rec.intent) && rec.intent !== "meeting_request") {
    await ctx.store.put("scheduling_queue", { id: lead.id, leadId: lead.id, inboundId: msg.id, proposedTimes: rec.proposedTimes, at: ctx.now().toISOString() });
    actions.push("passed to the meeting scheduler");
  }
  if (!openMeeting && !["unsubscribe", "not_interested", "out_of_office", "exclusivity_request", "pricing_request", "meeting_request"].includes(rec.intent) && !rec.suspicious) {
    try {
      const d = await draftOutreach(ctx, {
        leadIds: [lead.id],
        kind: "reply",
        language: det.confidence >= 0.6 ? det.language : (current.language ?? undefined),
        purpose: `reply to their message (intent: ${rec.intent})`,
        extra: `Their message summary: ${rec.summary}\nTheir requests: ${rec.requests.join("; ")}\nAnswer only what approved facts allow; for anything else say the team will follow up.`,
      });
      if (d.drafted[0]) {
        const reply = { ...d.drafted[0], threadId: msg.threadId, inReplyTo: msg.messageId, subject: /^re:/i.test(d.drafted[0].subject) ? d.drafted[0].subject : `Re: ${msg.subject}` };
        reply.contentHash = messageHash(reply);
        await ctx.store.put("outreach", reply);
        actions.push("reply drafted for your approval");
      }
    } catch (e) {
      actions.push(`reply draft failed: ${errorMessage(e)}`);
    }
  }
  if (rec.suspicious) actions.push("⚠ message contained instruction-like text; no automatic reply drafted");
  rec.actions = actions;
  await ctx.store.put("inbound", rec);
  await logActivity(ctx, {
    actor: "bingo",
    action: "inbox.reply",
    summary: `Reply from ${lead.company} [${det.language}]: ${rec.intent} — ${rec.summary.slice(0, 160)}`,
    level: rec.intent === "exclusivity_request" || rec.suspicious ? "warning" : "info",
    workspaceId: lead.workspaceId,
    ref: { kind: "lead", id: lead.id },
  });
  return rec;
}

/** Scheduled job: checks every outreach thread for new replies. */
export async function pollReplies(ctx: Ctx): Promise<{ checked: number; processed: number; errors: string[] }> {
  const res = { checked: 0, processed: 0, errors: [] as string[] };
  const leads = (await listLeads(ctx)).filter((l) => l.threadIds.length && !l.optedOut);
  const ourAddresses = new Set<string>();
  const owner = await getOwner(ctx);
  if (owner.email) ourAddresses.add(owner.email.toLowerCase());
  const touched: Lead[] = [];
  for (const lead of leads) {
    if (!(await googleConnected(ctx, lead.workspaceId))) continue;
    for (const threadId of lead.threadIds) {
      res.checked++;
      try {
        const msgs = await gmailThread(ctx, threadId, lead.workspaceId);
        for (const m of msgs) {
          const from = (m.from.match(/<([^>]+)>/)?.[1] ?? m.from).toLowerCase();
          if (m.labelIds.includes("SENT") || ourAddresses.has(from)) continue;
          const r = await processInboundMessage(ctx, (await ctx.store.get<Lead>("leads", lead.id)) ?? lead, m);
          if (r) {
            res.processed++;
            touched.push((await ctx.store.get<Lead>("leads", lead.id))!);
          }
        }
      } catch (e) {
        res.errors.push(`${lead.company}: ${errorMessage(e)}`);
      }
    }
  }
  if (touched.length) await syncLeadsToSheet(ctx, touched);
  return res;
}
