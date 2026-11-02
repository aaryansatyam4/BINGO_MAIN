import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { authorize, countToday, recordAction } from "@/core/policy";
import { getOwner } from "@/core/settings";
import { errorMessage, escapeHtml, newId } from "@/core/util";
import { gmailSend, googleConnected } from "@/integrations/google";
import { telegramSend } from "@/integrations/telegram";
import { placeOwnerCall, telephonyReady } from "./telephony";

/**
 * BINGO PRIORITY CALL — severity-based escalation with quiet hours, VIPs,
 * do-not-disturb, call limits, call budget, acknowledgement tracking and
 * fallback channels. The policy is plain data the owner can edit or change
 * by speaking to BINGO ("call me for emergencies, Telegram for routine").
 */
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export const SEVERITIES: Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
export type Channel = "activity" | "app" | "telegram" | "email" | "call";

export interface EscalationPolicy {
  id: "escalation";
  channels: Record<Severity, Channel[]>;
  categorySeverity: Record<string, Severity>;
  vip: { match: string; minSeverity: Severity }[];
  quietHours: { enabled: boolean; start: string; end: string; allowCritical: boolean };
  dndUntil: string | null;
  maxCallsPerIncident: number;
  maxCallsPerDay: number;
  ackTimeoutMinutes: number;
  monthlyCallBudgetUsd: number;
  estimatedCallCostUsd: number;
  callOnlyVerified: boolean;
  updatedAt: string;
  history: { at: string; instruction: string; changes: string[] }[];
}

export const DEFAULT_ESCALATION: EscalationPolicy = {
  id: "escalation",
  channels: { LOW: ["activity"], MEDIUM: ["activity", "telegram"], HIGH: ["activity", "app", "telegram", "email"], CRITICAL: ["activity", "app", "telegram", "call"] },
  categorySeverity: {
    exclusivity_request: "HIGH",
    pricing_request: "MEDIUM",
    security_incident: "CRITICAL",
    deployment_down: "HIGH",
    payment_risk: "CRITICAL",
    regulatory_issue: "HIGH",
    contract_commitment: "HIGH",
  },
  vip: [],
  quietHours: { enabled: true, start: "22:00", end: "07:00", allowCritical: true },
  dndUntil: null,
  maxCallsPerIncident: 2,
  maxCallsPerDay: 4,
  ackTimeoutMinutes: 10,
  monthlyCallBudgetUsd: 25,
  estimatedCallCostUsd: 0.15,
  callOnlyVerified: true,
  updatedAt: new Date(0).toISOString(),
  history: [],
};

export async function getEscalationPolicy(ctx: Ctx): Promise<EscalationPolicy> {
  const p = await ctx.store.get<EscalationPolicy>("settings", "escalation");
  return { ...DEFAULT_ESCALATION, ...(p ?? {}), channels: { ...DEFAULT_ESCALATION.channels, ...(p?.channels ?? {}) } };
}

export async function saveEscalationPolicy(ctx: Ctx, p: EscalationPolicy) {
  await ctx.store.put("settings", { ...p, updatedAt: ctx.now().toISOString() });
}

// ---------------------------------------------------------------------------
// Natural-language policy updates
// ---------------------------------------------------------------------------

function parseClock(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]?.toLowerCase() === "pm" && h < 12) h += 12;
  if (m[3]?.toLowerCase() === "am" && h === 12) h = 0;
  return h < 24 && min < 60 ? `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}` : null;
}

export function applyPolicyInstruction(policy: EscalationPolicy, text: string, now: Date): { policy: EscalationPolicy; changes: string[] } {
  const p = structuredClone(policy);
  const t = text.toLowerCase();
  const changes: string[] = [];
  const has = (re: RegExp) => re.test(t);

  if (has(/call me (immediately |right away |straight away )?(for|on|about|when)[^,.;]*(major|critical|serious|emergenc|urgent)/)) {
    if (!p.channels.CRITICAL.includes("call")) p.channels.CRITICAL.push("call");
    if (!p.channels.CRITICAL.includes("telegram")) p.channels.CRITICAL.push("telegram");
    changes.push("CRITICAL issues → phone call (+ Telegram)");
  }
  if (has(/(routine|minor|small|normal|everything else)[^,.;]*telegram/)) {
    p.channels.LOW = ["activity", "telegram"];
    p.channels.MEDIUM = ["activity", "telegram"];
    changes.push("Routine (LOW/MEDIUM) → Telegram");
  }
  if (has(/(important|high|time.sensitive)[^,.;]*(call)/) && !has(/(don't|do not|never) call/)) {
    if (!p.channels.HIGH.includes("call")) p.channels.HIGH.push("call");
    changes.push("HIGH issues → also phone call");
  }
  if (has(/(don't|do not|never) call me (for|about) (high|important)/)) {
    p.channels.HIGH = p.channels.HIGH.filter((c) => c !== "call");
    changes.push("HIGH issues → no phone call");
  }
  if (has(/(email|gmail)[^,.;]*(high|important)|(high|important)[^,.;]*(email|gmail)/)) {
    if (!p.channels.HIGH.includes("email")) p.channels.HIGH.push("email");
    changes.push("HIGH issues → also email");
  }
  const quiet = t.match(/(?:don't|do not|no) (?:call|calls|disturb)[^,.;]*?(?:between|from)\s+([\d: ]+(?:am|pm)?)\s+(?:and|to|-)\s+([\d: ]+(?:am|pm)?)/);
  if (quiet) {
    const a = parseClock(quiet[1]!);
    const b = parseClock(quiet[2]!);
    if (a && b) {
      p.quietHours = { ...p.quietHours, enabled: true, start: a, end: b };
      changes.push(`Quiet hours ${a}–${b}${p.quietHours.allowCritical ? " (critical still allowed)" : ""}`);
    }
  }
  if (has(/even (for )?critical|no exceptions|nothing at all/)) {
    p.quietHours.allowCritical = false;
    changes.push("Quiet hours apply to critical issues too");
  }
  const dndFor = t.match(/do not disturb (?:me )?for (\d+)\s*(minutes?|hours?|days?)/);
  if (dndFor) {
    const n = Number(dndFor[1]);
    const ms = dndFor[2]!.startsWith("min") ? n * 6e4 : dndFor[2]!.startsWith("hour") ? n * 36e5 : n * 864e5;
    p.dndUntil = new Date(now.getTime() + ms).toISOString();
    changes.push(`Do not disturb until ${p.dndUntil}`);
  }
  if (has(/(cancel|turn off|end|stop) (do not disturb|dnd)/)) {
    p.dndUntil = null;
    changes.push("Do not disturb off");
  }
  const vip = text.match(/treat (.+?) as (?:a )?vip/i);
  if (vip) {
    p.vip.push({ match: vip[1]!.trim(), minSeverity: "HIGH" });
    changes.push(`VIP: ${vip[1]!.trim()} → at least HIGH`);
  }
  const maxCalls = t.match(/(?:at most|no more than|max(?:imum)?) (\d+) calls? (?:a|per) day/);
  if (maxCalls) {
    p.maxCallsPerDay = Number(maxCalls[1]);
    changes.push(`At most ${p.maxCallsPerDay} calls per day`);
  }
  const budget = t.match(/call budget (?:of |to )?\$?(\d+)/);
  if (budget) {
    p.monthlyCallBudgetUsd = Number(budget[1]);
    changes.push(`Monthly call budget $${p.monthlyCallBudgetUsd}`);
  }
  if (changes.length) p.history = [...p.history, { at: now.toISOString(), instruction: text, changes }].slice(-50);
  return { policy: p, changes };
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export interface Incident {
  id: string;
  workspaceId?: string;
  severity: Severity;
  requestedSeverity?: Severity;
  category: string;
  title: string;
  summary: string;
  details: string;
  options: { label: string; description: string }[];
  recommendation: string;
  source: { kind: string; id: string };
  verified: boolean;
  counterparty?: { company?: string; email?: string; domain?: string };
  status: "open" | "acknowledged" | "resolved";
  createdAt: string;
  deliveries: { channel: Channel; at: string; ok: boolean; detail: string }[];
  calls: { sid: string; at: string; status: string; provider: string }[];
  ackAt?: string;
  ackVia?: string;
  decision?: { option: string; at: string; via: string; note?: string };
  nextCheckAt?: string;
}

export type EscalateInput = Pick<Incident, "category" | "title" | "summary" | "details" | "options" | "recommendation" | "source" | "verified"> & {
  workspaceId?: string;
  severity?: Severity;
  counterparty?: Incident["counterparty"];
};

const rank = (s: Severity) => SEVERITIES.indexOf(s);
const maxSev = (a: Severity, b: Severity) => (rank(a) >= rank(b) ? a : b);

export function classifySeverity(policy: EscalationPolicy, input: EscalateInput): Severity {
  let sev: Severity = input.severity ?? policy.categorySeverity[input.category] ?? "MEDIUM";
  const cp = [input.counterparty?.company, input.counterparty?.email, input.counterparty?.domain].filter(Boolean).join(" ").toLowerCase();
  for (const v of policy.vip) if (cp && cp.includes(v.match.toLowerCase())) sev = maxSev(sev, v.minSeverity);
  return sev;
}

function minutesOfDay(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")!.value);
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  return h * 60 + m;
}

export function inQuietHours(policy: EscalationPolicy, now: Date, tz: string): boolean {
  if (!policy.quietHours.enabled) return false;
  const [sh, sm] = policy.quietHours.start.split(":").map(Number) as [number, number];
  const [eh, em] = policy.quietHours.end.split(":").map(Number) as [number, number];
  const cur = minutesOfDay(now, tz);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

export interface ChannelDecision {
  channels: Channel[];
  suppressed: { channel: Channel; reason: string }[];
}

/** Pure decision function — easy to test and to show to the owner. */
export function decideChannels(policy: EscalationPolicy, severity: Severity, ctx: { now: Date; timezone: string; verified: boolean; callsToday: number; callsThisIncident: number; callSpendThisMonth: number; telephony: boolean }): ChannelDecision {
  const wanted = [...policy.channels[severity]];
  const channels: Channel[] = [];
  const suppressed: ChannelDecision["suppressed"] = [];
  const dnd = policy.dndUntil && new Date(policy.dndUntil) > ctx.now;
  const quiet = inQuietHours(policy, ctx.now, ctx.timezone);
  for (const c of wanted) {
    if (c === "activity") {
      channels.push(c);
      continue;
    }
    if (dnd && !(severity === "CRITICAL" && policy.quietHours.allowCritical)) {
      suppressed.push({ channel: c, reason: "Do not disturb" });
      continue;
    }
    if (c === "call") {
      if (quiet && !(severity === "CRITICAL" && policy.quietHours.allowCritical)) suppressed.push({ channel: c, reason: "Quiet hours" });
      else if (policy.callOnlyVerified && !ctx.verified) suppressed.push({ channel: c, reason: "Incident not verified — BINGO only calls for verified events" });
      else if (ctx.callsThisIncident >= policy.maxCallsPerIncident) suppressed.push({ channel: c, reason: "Repeat-call limit for this incident" });
      else if (ctx.callsToday >= policy.maxCallsPerDay) suppressed.push({ channel: c, reason: "Daily call limit" });
      else if (ctx.callSpendThisMonth + policy.estimatedCallCostUsd > policy.monthlyCallBudgetUsd) suppressed.push({ channel: c, reason: "Monthly call budget" });
      else if (!ctx.telephony) suppressed.push({ channel: c, reason: "No telephony provider connected" });
      else channels.push(c);
      continue;
    }
    if (quiet && severity !== "CRITICAL" && c !== "app") {
      suppressed.push({ channel: c, reason: "Quiet hours (will appear in the app)" });
      continue;
    }
    channels.push(c);
  }
  // A suppressed call falls back to the strongest silent channels.
  if (suppressed.some((s) => s.channel === "call")) for (const c of ["telegram", "app"] as Channel[]) if (!channels.includes(c) && !(dnd && severity !== "CRITICAL")) channels.push(c);
  return { channels, suppressed };
}

async function callSpend(ctx: Ctx) {
  const month = ctx.now().toISOString().slice(0, 7);
  return (await ctx.store.get<{ id: string; usd: number }>("call_spend", month))?.usd ?? 0;
}

export async function escalate(ctx: Ctx, input: EscalateInput): Promise<Incident> {
  const policy = await getEscalationPolicy(ctx);
  const owner = await getOwner(ctx);
  // De-duplicate: same source → same incident.
  const existing = (await ctx.store.list<Incident>("incidents", { where: { status: "open" } })).find((i) => i.source.kind === input.source.kind && i.source.id === input.source.id);
  if (existing) return existing;
  const severity = classifySeverity(policy, input);
  const incident: Incident = {
    id: newId("inc"),
    workspaceId: input.workspaceId,
    severity,
    requestedSeverity: input.severity,
    category: input.category,
    title: input.title,
    summary: input.summary,
    details: input.details,
    options: input.options,
    recommendation: input.recommendation,
    source: input.source,
    verified: input.verified,
    counterparty: input.counterparty,
    status: "open",
    createdAt: ctx.now().toISOString(),
    deliveries: [],
    calls: [],
  };
  await ctx.store.put("incidents", incident);
  return deliver(ctx, incident, policy, owner.timezone);
}

async function deliver(ctx: Ctx, incident: Incident, policy: EscalationPolicy, tz: string): Promise<Incident> {
  const inc = structuredClone(incident);
  const decision = decideChannels(policy, inc.severity, {
    now: ctx.now(),
    timezone: tz,
    verified: inc.verified,
    callsToday: await countToday(ctx, "call.owner"),
    callsThisIncident: inc.calls.length,
    callSpendThisMonth: await callSpend(ctx),
    telephony: await telephonyReady(ctx),
  });
  const stamp = () => ctx.now().toISOString();
  for (const s of decision.suppressed) inc.deliveries.push({ channel: s.channel, at: stamp(), ok: false, detail: `suppressed: ${s.reason}` });
  for (const c of decision.channels) {
    try {
      if (c === "activity" || c === "app") {
        await logActivity(ctx, { actor: "bingo", action: `escalation.${inc.severity.toLowerCase()}`, summary: `[${inc.severity}] ${inc.title}`, level: rank(inc.severity) >= 2 ? "warning" : "info", workspaceId: inc.workspaceId, ref: { kind: "incident", id: inc.id } });
        inc.deliveries.push({ channel: c, at: stamp(), ok: true, detail: "shown in BINGO" });
      } else if (c === "telegram") {
        const auth = await authorize(ctx, { kind: "telegram.notify.owner", payload: { incident: inc.id }, title: "Notify owner", summary: inc.title, requestedBy: "bingo" });
        if (!auth.allowed) throw new Error(auth.reason);
        const r = await telegramSend(ctx, `${sevIcon(inc.severity)} <b>${inc.severity}: ${escapeHtml(inc.title)}</b>\n\n${escapeHtml(inc.summary)}\n\n<b>Recommendation:</b> ${escapeHtml(inc.recommendation)}`, {
          buttons: [[{ text: "✅ Acknowledge", data: `ack:${inc.id}` }], ...inc.options.slice(0, 3).map((o, i) => [{ text: o.label.slice(0, 40), data: `opt:${inc.id}:${i}` }])],
        });
        inc.deliveries.push({ channel: c, at: stamp(), ok: "messageId" in r, detail: "messageId" in r ? `message ${r.messageId}` : r.skipped });
      } else if (c === "email") {
        const owner = await getOwner(ctx);
        if (!owner.email || !(await googleConnected(ctx))) throw new Error("Owner email / Gmail not connected");
        const r = await gmailSend(ctx, { to: [owner.email], subject: `[BINGO ${inc.severity}] ${inc.title}`, text: `${inc.summary}\n\nRecommendation: ${inc.recommendation}\n\nOptions:\n${inc.options.map((o) => `- ${o.label}: ${o.description}`).join("\n")}\n\nDetails:\n${inc.details}\n\nOpen BINGO: ${ctx.env.publicUrl}/speak#${inc.id}` });
        inc.deliveries.push({ channel: c, at: stamp(), ok: true, detail: `gmail ${r.id}` });
      } else if (c === "call") {
        const auth = await authorize(ctx, { kind: "phone.call.owner", payload: { incident: inc.id, attempt: inc.calls.length + 1 }, title: "Call owner", summary: inc.title, requestedBy: "bingo" });
        if (!auth.allowed) throw new Error(auth.reason);
        const call = await placeOwnerCall(ctx, inc);
        inc.calls.push({ sid: call.sid, at: stamp(), status: call.status, provider: call.provider });
        await recordAction(ctx, "call.owner", { incident: inc.id, sid: call.sid });
        const month = ctx.now().toISOString().slice(0, 7);
        await ctx.store.put("call_spend", { id: month, usd: (await callSpend(ctx)) + policy.estimatedCallCostUsd });
        inc.deliveries.push({ channel: c, at: stamp(), ok: true, detail: `call ${call.sid} (${call.status}) via ${call.provider}` });
      }
    } catch (e) {
      inc.deliveries.push({ channel: c, at: stamp(), ok: false, detail: errorMessage(e) });
    }
  }
  if (decision.channels.includes("call") || rank(inc.severity) >= 2) inc.nextCheckAt = new Date(ctx.now().getTime() + policy.ackTimeoutMinutes * 6e4).toISOString();
  await ctx.store.put("incidents", inc);
  return inc;
}

const sevIcon = (s: Severity) => ({ LOW: "ℹ️", MEDIUM: "🔔", HIGH: "⚠️", CRITICAL: "🚨" })[s];

export async function acknowledge(ctx: Ctx, id: string, via: string) {
  const inc = await ctx.store.get<Incident>("incidents", id);
  if (!inc) throw new Error("Incident not found");
  if (inc.status !== "open") return inc;
  const next: Incident = { ...inc, status: "acknowledged", ackAt: ctx.now().toISOString(), ackVia: via, nextCheckAt: undefined };
  await ctx.store.put("incidents", next);
  await logActivity(ctx, { actor: "owner", action: "escalation.ack", summary: `Acknowledged via ${via}: ${inc.title}`, level: "success", ref: { kind: "incident", id } });
  return next;
}

/** Records the owner's decision. It never executes a commitment by itself. */
export async function decide(ctx: Ctx, id: string, optionIndex: number, via: string, note?: string) {
  const inc = await ctx.store.get<Incident>("incidents", id);
  if (!inc) throw new Error("Incident not found");
  const option = inc.options[optionIndex];
  if (!option) throw new Error("Unknown option");
  const next: Incident = { ...inc, status: "resolved", ackAt: inc.ackAt ?? ctx.now().toISOString(), ackVia: inc.ackVia ?? via, decision: { option: option.label, at: ctx.now().toISOString(), via, note }, nextCheckAt: undefined };
  await ctx.store.put("incidents", next);
  await logActivity(ctx, { actor: "owner", action: "escalation.decided", summary: `Decision on "${inc.title}": ${option.label}`, level: "success", ref: { kind: "incident", id } });
  return next;
}

/** Scheduled: re-notify / call again / fall back when an important incident is not acknowledged. */
export async function followUpIncidents(ctx: Ctx) {
  const policy = await getEscalationPolicy(ctx);
  const owner = await getOwner(ctx);
  const due = (await ctx.store.list<Incident>("incidents", { where: { status: "open" } })).filter((i) => i.nextCheckAt && new Date(i.nextCheckAt) <= ctx.now());
  const out: string[] = [];
  for (const inc of due) {
    const attempts = inc.deliveries.filter((d) => d.detail.startsWith("follow-up")).length;
    if (attempts >= 3) {
      await ctx.store.put("incidents", { ...inc, nextCheckAt: undefined });
      continue;
    }
    const marker: Incident = { ...inc, deliveries: [...inc.deliveries, { channel: "activity", at: ctx.now().toISOString(), ok: true, detail: `follow-up #${attempts + 1}: not acknowledged after ${policy.ackTimeoutMinutes} min` }] };
    await deliver(ctx, marker, policy, owner.timezone);
    out.push(inc.id);
  }
  return out;
}
