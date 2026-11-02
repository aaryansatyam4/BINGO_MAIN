import { z } from "zod";
import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { callJson } from "@/ai/engine";
import { authorize, countToday, getPolicy, recordAction } from "@/core/policy";
import { getOwner } from "@/core/settings";
import { errorMessage, hashPayload, newId, normalizeDomain } from "@/core/util";
import { gmailSend, googleConnected } from "@/integrations/google";
import { pushToSheet } from "@/integrations/sheets-sync";
import { link, upsertNode } from "@/core/graph";
import { languageName } from "@/lang/detect";
import { translateText, type TranslationRecord } from "@/lang/translate";
import { brandContext, brandKitForWorkspace } from "@/studio/brand";
import { checkCompliance, type ComplianceResult } from "@/studio/claims";
import { UNTRUSTED_SYSTEM_RULES, wrapUntrusted } from "@/security/untrusted";
import { getLead, isSuppressed, saveLead, setStage, type Lead } from "./crm";

/**
 * Controlled outreach. Every external email:
 *  - uses only approved company/product facts,
 *  - passes deterministic compliance (no prices, exclusivity, registrations, claims),
 *  - is shown to the owner with a translation,
 *  - is sent only after approval bound to its exact content hash,
 *  - respects suppression, duplicate, verification and rate limits,
 *  - is recorded with the real Gmail message/thread IDs.
 */
export type OutreachKind = "initial" | "followup" | "reply" | "scheduling" | "share_page";
export type OutreachStatus = "draft" | "awaiting_approval" | "approved" | "sent" | "failed" | "blocked" | "suppressed" | "rejected";

export interface OutreachMessage {
  id: string;
  workspaceId: string;
  leadId: string;
  kind: OutreachKind;
  to: string;
  subject: string;
  body: string;
  language: string;
  forOwner: Pick<TranslationRecord, "translated" | "needsReview" | "reviewReasons" | "targetLanguage"> | null;
  compliance: ComplianceResult;
  status: OutreachStatus;
  contentHash: string;
  approvedHash?: string;
  approvalId?: string;
  threadId?: string;
  inReplyTo?: string;
  gmail?: { id: string; threadId: string; labelIds?: string[] };
  sentAt?: string;
  error?: string;
  createdAt: string;
  workflowId?: string;
}

const EmailSchema = z.object({ subject: z.string(), body: z.string(), personalization: z.string() });

const OUTREACH_GUARDS = [
  { re: /\bexclusiv\w*|эксклюзив\w*|eksklyuziv\w*|حصري/i, reason: "Mentions exclusivity — BINGO has no authority to offer it" },
  { re: /\b(registered|registration certificate|approved by|licen[cs]ed in)\b|зарегистрирован|регистрационн/i, reason: "Mentions product registration/approval status" },
  { re: /\b(margin|discount|price list|pricing|per unit|MOQ)\b|\d+\s?%\s?(margin|discount)|цен[аы]|скидк/i, reason: "Mentions commercial terms (prices, margins, discounts)" },
];

export function outreachChecks(text: string, kit: Awaited<ReturnType<typeof brandKitForWorkspace>>, opts: { market?: string } = {}): ComplianceResult {
  const base = kit ? checkCompliance(text, kit, null, { market: opts.market }) : { status: "pass" as const, issues: [], matchedClaims: [] };
  const issues = [...base.issues];
  const approved = kit ? [...kit.companyFacts].join(" ") : "";
  for (const g of OUTREACH_GUARDS) {
    const m = text.match(g.re);
    if (m && !new RegExp(g.re.source, "i").test(approved)) issues.push({ severity: "block", text: m[0], reason: g.reason });
  }
  const status = issues.some((i) => i.severity === "block") ? "blocked" : issues.length ? "needs_review" : "pass";
  return { status, issues, matchedClaims: base.matchedClaims };
}

const UNSUBSCRIBE_LINE: Record<string, string> = {
  en: "If you would prefer not to hear from us again, simply reply “unsubscribe” and we will not contact you further.",
};

async function unsubscribeLine(ctx: Ctx, language: string, workspaceId: string): Promise<string> {
  if (UNSUBSCRIBE_LINE[language]) return UNSUBSCRIBE_LINE[language]!;
  const cached = await ctx.store.get<{ id: string; text: string }>("i18n_cache", `unsub:${language}`);
  if (cached) return cached.text;
  try {
    const t = await translateText(ctx, UNSUBSCRIBE_LINE.en!, language, { source: "en", workspaceId, purpose: "outreach.unsubscribe" });
    await ctx.store.put("i18n_cache", { id: `unsub:${language}`, text: t.translated });
    return t.translated;
  } catch {
    return UNSUBSCRIBE_LINE.en!;
  }
}

export function bestEmail(lead: Lead): { address: string; verified: boolean } | null {
  const v = lead.emails.find((e) => e.verified) ?? lead.emails.find((e) => normalizeDomain(e.address) === lead.domain) ?? lead.emails[0];
  return v ? { address: v.address, verified: v.verified } : null;
}

export async function draftOutreach(
  ctx: Ctx,
  input: { leadIds: string[]; kind?: OutreachKind; language?: string; purpose?: string; extra?: string; workflowId?: string },
): Promise<{ drafted: OutreachMessage[]; skipped: { leadId: string; reason: string }[] }> {
  const owner = await getOwner(ctx);
  const drafted: OutreachMessage[] = [];
  const skipped: { leadId: string; reason: string }[] = [];
  for (const id of input.leadIds) {
    const lead = await getLead(ctx, id);
    if (!lead) continue;
    if (lead.optedOut || lead.doNotContact) {
      skipped.push({ leadId: id, reason: "Opted out / do not contact" });
      continue;
    }
    const email = bestEmail(lead);
    if (!email) {
      skipped.push({ leadId: id, reason: "No email address" });
      continue;
    }
    const kind = input.kind ?? "initial";
    if (kind === "initial") {
      const prior = await ctx.store.list<OutreachMessage>("outreach", { where: { leadId: id, kind: "initial" } });
      if (prior.some((m) => ["sent", "approved", "awaiting_approval", "draft"].includes(m.status))) {
        skipped.push({ leadId: id, reason: "An introduction already exists for this lead" });
        continue;
      }
    }
    const kit = await brandKitForWorkspace(ctx, lead.workspaceId);
    const language = input.language ?? lead.language ?? "en";
    const unsub = await unsubscribeLine(ctx, language, lead.workspaceId);
    const { data } = await callJson(
      ctx,
      {
        capability: "copywriting",
        system: [
          `You write concise, professional B2B emails for international pharmaceutical/nutraceutical business development, natively in ${languageName(language)} (${language}).`,
          kit ? brandContext(kit, null, lead.country) : "",
          kit?.products.length ? `Product names you may mention: ${kit.products.map((p) => p.name).join(", ")}.` : "",
          "Rules: be truthful and specific to the recipient; use only approved facts; never mention prices, margins, discounts, exclusivity, product registrations, certifications or approvals; no exaggerated claims; 120–180 words; one clear ask (a short introductory call or interest in receiving the company profile).",
          `Sign as ${owner.name}${owner.email ? ` (${owner.email})` : ""}.`,
          UNTRUSTED_SYSTEM_RULES,
        ]
          .filter(Boolean)
          .join("\n"),
        prompt: `Email type: ${kind}${input.purpose ? ` — ${input.purpose}` : ""}\n${input.extra ?? ""}\nRecipient company (from research, verify nothing beyond this):\n${wrapUntrusted("crm-record", `${lead.company}, ${lead.city ? `${lead.city}, ` : ""}${lead.country}\n${lead.description}\nPortfolio fit: ${lead.portfolioFit}`).block}\n\npersonalization: one sentence explaining which recipient detail you used.`,
        effort: "medium",
      },
      EmailSchema,
      { workspaceId: lead.workspaceId, purpose: `outreach.${kind}` },
    );
    const body = `${data.body.trim()}\n\n—\n${unsub}`;
    const compliance = outreachChecks(`${data.subject}\n${data.body}`, kit, { market: lead.country });
    let forOwner: OutreachMessage["forOwner"] = null;
    if (language.split("-")[0] !== owner.preferredLanguage.split("-")[0]) {
      try {
        const t = await translateText(ctx, `${data.subject}\n\n${body}`, owner.preferredLanguage, { source: language, glossary: { keep: [lead.company, ...(kit?.products.map((p) => p.name) ?? []), kit?.name ?? ""] }, workspaceId: lead.workspaceId, purpose: "outreach.review-translation" });
        forOwner = { translated: t.translated, needsReview: t.needsReview, reviewReasons: t.reviewReasons, targetLanguage: t.targetLanguage };
      } catch (e) {
        forOwner = { translated: "", needsReview: true, reviewReasons: [`Translation for review failed: ${errorMessage(e)}`], targetLanguage: owner.preferredLanguage };
      }
    }
    const msg: OutreachMessage = {
      id: newId("out"),
      workspaceId: lead.workspaceId,
      leadId: lead.id,
      kind,
      to: email.address,
      subject: data.subject.trim(),
      body,
      language,
      forOwner,
      compliance,
      status: compliance.status === "blocked" ? "blocked" : "draft",
      contentHash: "",
      createdAt: ctx.now().toISOString(),
      workflowId: input.workflowId,
      threadId: kind !== "initial" ? lead.threadIds.at(-1) : undefined,
    };
    msg.contentHash = messageHash(msg);
    if (!email.verified) msg.compliance = { ...msg.compliance, issues: [...msg.compliance.issues, { severity: "review", text: email.address, reason: "Recipient address was not found on the company's official website" }] };
    await ctx.store.put("outreach", msg);
    drafted.push(msg);
  }
  return { drafted, skipped };
}

export function messageHash(m: Pick<OutreachMessage, "to" | "subject" | "body" | "threadId">) {
  return hashPayload({ to: m.to.toLowerCase(), subject: m.subject, body: m.body, threadId: m.threadId ?? null });
}

export async function listOutreach(ctx: Ctx, where: Partial<Pick<OutreachMessage, "status" | "leadId" | "workspaceId">> = {}) {
  return ctx.store.list<OutreachMessage>("outreach", { where: where as Record<string, unknown> });
}

/** Owner edits a draft. Any edit invalidates earlier approval because the hash changes. */
export async function editDraft(ctx: Ctx, id: string, patch: { subject?: string; body?: string; to?: string }) {
  const m = await ctx.store.get<OutreachMessage>("outreach", id);
  if (!m || ["sent"].includes(m.status)) throw new Error("Cannot edit this message");
  const kit = await brandKitForWorkspace(ctx, m.workspaceId);
  const next = { ...m, ...patch };
  next.contentHash = messageHash(next);
  next.compliance = outreachChecks(`${next.subject}\n${next.body}`, kit);
  next.status = next.compliance.status === "blocked" ? "blocked" : "draft";
  next.approvedHash = undefined;
  await ctx.store.put("outreach", next);
  return next;
}

/** One approval request covering a batch of drafts, bound to each message's content hash. */
export async function requestSendApproval(ctx: Ctx, ids: string[], opts: { approvalId?: string; workflowId?: string; stepId?: string } = {}) {
  const msgs = (await Promise.all(ids.map((id) => ctx.store.get<OutreachMessage>("outreach", id)))).filter((m): m is NonNullable<typeof m> => !!m && ["draft", "awaiting_approval", "approved"].includes(m.status));
  const pending = msgs.filter((m) => m.status !== "approved");
  if (!pending.length) return { status: "approved" as const, approved: msgs.length };
  const kinds = new Set(pending.map((m) => (m.kind === "initial" || m.kind === "share_page" ? "email.send.initial" : "email.send.reply")));
  const kind = kinds.has("email.send.initial") ? "email.send.initial" : "email.send.reply";
  const payload = { messages: pending.map((m) => ({ id: m.id, to: m.to, hash: m.contentHash })) };
  const leads = await Promise.all(pending.map((m) => getLead(ctx, m.leadId)));
  const auth = await authorize(ctx, {
    kind,
    workspaceId: pending[0]!.workspaceId,
    payload,
    title: `Send ${pending.length} email(s) — ${pending[0]!.kind === "initial" ? "first contact" : pending[0]!.kind}`,
    summary: pending
      .map((m, i) => `• ${leads[i]?.company ?? m.to} <${m.to}> [${m.language}] “${m.subject}”${m.compliance.issues.length ? ` ⚠ ${m.compliance.issues.length} item(s) to review` : ""}${m.forOwner?.needsReview ? " ⚠ translation flagged" : ""}`)
      .join("\n"),
    requestedBy: "bingo",
    approvalId: opts.approvalId,
    workflowId: opts.workflowId,
    stepId: opts.stepId,
  });
  if (!auth.allowed) {
    for (const m of pending) await ctx.store.put("outreach", { ...m, status: auth.blocked ? m.status : "awaiting_approval", approvalId: auth.approval?.id });
    return { status: auth.blocked ? ("blocked" as const) : ("awaiting_approval" as const), approvalId: auth.approval?.id, reason: auth.reason };
  }
  for (const m of pending) {
    await ctx.store.put("outreach", { ...m, status: "approved", approvedHash: m.contentHash, approvalId: auth.approvalId ?? auth.via });
    if (m.kind === "initial") {
      const lead = await getLead(ctx, m.leadId);
      if (lead) await setStage(ctx, lead, "Outreach Approved", "bingo");
    }
  }
  return { status: "approved" as const, approved: pending.length };
}

export interface SendReport {
  sent: { id: string; to: string; gmailId: string; threadId: string }[];
  deferred: { id: string; reason: string }[];
  failed: { id: string; error: string }[];
  suppressed: { id: string; reason: string }[];
}

/** Sends approved messages, enforcing limits. Unsent messages stay approved for the next run. */
export async function sendApproved(ctx: Ctx, ids?: string[]): Promise<SendReport> {
  const report: SendReport = { sent: [], deferred: [], failed: [], suppressed: [] };
  const approved = (await listOutreach(ctx, { status: "approved" })).filter((m) => !ids || ids.includes(m.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const m of approved) {
    const policy = await getPolicy(ctx, m.workspaceId);
    if (m.approvedHash !== messageHash(m)) {
      await ctx.store.put("outreach", { ...m, status: "draft", approvedHash: undefined });
      report.deferred.push({ id: m.id, reason: "Content changed after approval — needs approval again" });
      continue;
    }
    const lead = await getLead(ctx, m.leadId);
    const why = !lead ? "Lead deleted" : lead.optedOut || lead.doNotContact ? "Recipient opted out" : await isSuppressed(ctx, m.to);
    if (why) {
      await ctx.store.put("outreach", { ...m, status: "suppressed", error: why });
      report.suppressed.push({ id: m.id, reason: why });
      continue;
    }
    if (m.kind === "initial") {
      const sentBefore = (await listOutreach(ctx, { leadId: m.leadId })).some((x) => x.kind === "initial" && x.status === "sent" && x.id !== m.id);
      if (sentBefore) {
        await ctx.store.put("outreach", { ...m, status: "suppressed", error: "Introduction already sent to this lead" });
        report.suppressed.push({ id: m.id, reason: "duplicate introduction" });
        continue;
      }
      if ((await countToday(ctx, "email.initial")) >= policy.limits.initialEmailsPerDay) {
        report.deferred.push({ id: m.id, reason: `Daily limit of ${policy.limits.initialEmailsPerDay} first-contact emails reached` });
        continue;
      }
      const domain = normalizeDomain(m.to);
      if ((await countToday(ctx, "email.initial", (d) => d.domain === domain)) >= policy.limits.initialEmailsPerDomainPerDay) {
        report.deferred.push({ id: m.id, reason: `Per-domain limit reached for ${domain}` });
        continue;
      }
    }
    const last = (await ctx.store.list<{ id: string; at: string }>("action_ledger", { where: { kind: "email.any" }, limit: 1 }))[0];
    if (last && ctx.now().getTime() - new Date(last.at).getTime() < policy.limits.minSecondsBetweenEmails * 1000) {
      report.deferred.push({ id: m.id, reason: "Spacing emails out (rate limit) — will continue on the next run" });
      break;
    }
    if (!(await googleConnected(ctx, m.workspaceId))) {
      report.deferred.push({ id: m.id, reason: "Gmail is not connected" });
      continue;
    }
    const owner = await getOwner(ctx);
    try {
      const res = await gmailSend(
        ctx,
        {
          to: [m.to],
          subject: m.subject,
          text: m.body,
          threadId: m.threadId,
          inReplyTo: m.inReplyTo,
          listUnsubscribe: owner.email ? `<mailto:${owner.email}?subject=unsubscribe>` : undefined,
        },
        m.workspaceId,
      );
      if (!res?.id) throw new Error("Gmail did not return a message id");
      const sentAt = ctx.now().toISOString();
      await ctx.store.put("outreach", { ...m, status: "sent", gmail: res, threadId: res.threadId, sentAt, error: undefined });
      await recordAction(ctx, "email.any", { messageId: m.id });
      if (m.kind === "initial") await recordAction(ctx, "email.initial", { messageId: m.id, domain: normalizeDomain(m.to) });
      if (lead) {
        const updated = { ...lead, threadIds: [...new Set([...lead.threadIds, res.threadId])], lastContactAt: sentAt };
        await saveLead(ctx, updated);
        await setStage(ctx, updated, "Contacted", "bingo", `email ${res.id}`);
        await upsertNode(ctx, { id: `message:${res.id}`, kind: "message", label: m.subject, data: { direction: "out", language: m.language, at: sentAt } });
        await link(ctx, `company:${lead.id}`, "received", `message:${res.id}`);
      }
      report.sent.push({ id: m.id, to: m.to, gmailId: res.id, threadId: res.threadId });
      await pushToSheet(ctx, "outreach", [
        { "BINGO ID": m.id, "Lead ID": m.leadId, Company: lead?.company ?? "", To: m.to, Subject: m.subject, Language: m.language, Status: "submitted to Gmail", "Gmail Message ID": res.id, "Thread ID": res.threadId, "Sent At": sentAt, "Approved By": m.approvalId?.startsWith("apr_") ? "owner" : String(m.approvalId ?? "") },
      ]);
    } catch (e) {
      await ctx.store.put("outreach", { ...m, status: "failed", error: errorMessage(e) });
      report.failed.push({ id: m.id, error: errorMessage(e) });
    }
  }
  if (report.sent.length || report.failed.length)
    await logActivity(ctx, {
      actor: "bingo",
      action: "outreach.sent",
      summary: `Emails submitted to Gmail: ${report.sent.length}${report.failed.length ? `, failed: ${report.failed.length}` : ""}${report.deferred.length ? `, deferred: ${report.deferred.length}` : ""}`,
      level: report.failed.length ? "warning" : "success",
    });
  return report;
}
