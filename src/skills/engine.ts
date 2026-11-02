import { z } from "zod";
import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { callJson, route } from "@/ai/engine";
import { errorMessage, newId } from "@/core/util";
import { countryCode } from "@/global/crm";
import { listBrandKits } from "@/studio/brand";
import { EVENTS, INTENTS, STEP_TYPES, type BingoEvent, type Intent, type StepTemplate } from "@/orchestrator/catalog";

/**
 * Self-learning skill engine.
 * Preferences change parameters of future requests; workflows add steps or run
 * on events. Skills are declarative data, validated against the step catalogue,
 * and can never weaken approval policy or grant permissions.
 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  kind: "preference" | "workflow" | "policy";
  trigger: { type: "request"; intents: Intent[]; match: { country?: string; language?: string; keywords?: string[] } } | { type: "event"; event: BingoEvent; match: Record<string, string> };
  effect: { setParams?: Record<string, unknown>; addSteps?: StepTemplate[]; workflow?: StepTemplate[]; note?: string };
  status: "active" | "disabled" | "draft";
  version: number;
  createdFrom: string;
  createdAt: string;
  updatedAt: string;
  uses: number;
  feedback: { at: string; text: string; rating: -1 | 0 | 1 }[];
  validation: { ok: boolean; errors: string[]; warnings: string[] };
}

const LANG_WORDS: Record<string, string> = { russian: "ru", english: "en", hindi: "hi", uzbek: "uz", tajik: "tg", kyrgyz: "ky", turkmen: "tk", khmer: "km", lao: "lo", arabic: "ar", french: "fr", spanish: "es", german: "de", portuguese: "pt", chinese: "zh", mandarin: "zh", japanese: "ja", korean: "ko", nepali: "ne", bengali: "bn", urdu: "ur", tamil: "ta", telugu: "te" };

function languageIn(text: string): string | undefined {
  const t = text.toLowerCase();
  for (const [w, code] of Object.entries(LANG_WORDS)) if (new RegExp(`\\bin ${w}\\b|\\b${w} (language|version)`).test(t)) return code;
  return undefined;
}

function countryIn(text: string): string | undefined {
  const m = text.match(/\b(?:in|for|to)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/g) ?? [];
  for (const raw of m) {
    const name = raw.replace(/^(in|for|to)\s+/i, "");
    const code = countryCode(name);
    if (code) return code;
  }
  return undefined;
}

export function intentOf(text: string): Intent | null {
  const t = text.toLowerCase();
  if (/landing.?page|website|web page|site\b/.test(t)) return "build.landing";
  if (/creative|banner|poster|ad(vert)?s?\b|instagram|graphic|brochure|catalog/.test(t)) return "studio.creatives";
  if (/outreach|email (to )?distributor|contact (the )?distributor|introduc/.test(t)) return "global.outreach";
  if (/research|find .*distributor|distributors in/.test(t)) return "global.research";
  if (/meeting|interview|schedul/.test(t)) return "calendar.schedule";
  if (/report/.test(t)) return "report.create";
  return null;
}

/** Deterministic understanding of the common phrasings; falls back to the AI engine. */
export async function parseSkillInstruction(ctx: Ctx, text: string): Promise<Omit<Skill, "id" | "createdAt" | "updatedAt" | "uses" | "feedback" | "validation" | "version" | "status">> {
  const t = text.toLowerCase().trim();
  const base = { createdFrom: text };

  // "Whenever/Every time X is confirmed/launched/…, do Y" → event workflow
  const eventMap: [RegExp, BingoEvent][] = [
    [/meeting (is |gets )?confirmed/, "meeting.confirmed"],
    [/(launch|introduce|release) (a )?new product/, "product.launched"],
    [/(deployment|website|site|page) (is |goes )?(live|published|deployed)|approved deployment/, "deployment.production.live"],
    [/preview (is )?ready/, "deployment.preview.ready"],
    [/(new )?lead (comes in|arrives|submits)|form (is )?submitted/, "lead.inbound"],
  ];
  for (const [re, event] of eventMap) {
    if (!re.test(t)) continue;
    const steps: StepTemplate[] = [];
    if (/task|follow.?up/.test(t) && /sheet|task/.test(t))
      steps.push({ type: "tasks.create", title: "Follow-up task in company sheet", params: { ref: "{{event}}:{{id}}:followup", kind: event === "meeting.confirmed" ? "meeting_followup" : "general", title: event === "meeting.confirmed" ? "Prepare & follow up: meeting with {{company}}" : "Follow up: {{name}}", details: "Created by BINGO skill: {{skillName}}", deadlineDays: 2 } });
    if (/landing.?page/.test(t)) steps.push({ type: "build.plan", title: "Landing-page draft", params: { request: "Landing page for {{product}}" } }, { type: "build.content", params: { projectId: "$prev.projectId" } }, { type: "build.files", params: { projectId: "$prev.projectId" } }, { type: "build.checks", params: { projectId: "$prev.projectId" } });
    if (/creative|marketing|ad\b|campaign/.test(t)) steps.push({ type: "studio.generate", title: "Marketing creative proposal", params: { brief: "Launch creatives for {{product}}", count: 3, formats: ["instagram-square", "story", "web-hero"], productName: "{{product}}" } });
    if (/telegram/.test(t)) steps.push({ type: "notify.telegram", params: { text: event === "deployment.production.live" ? "✅ Live: {{project}} → {{url}}" : "{{summary}}" } });
    if (/email|gmail/.test(t) && !/task/.test(t)) steps.push({ type: "notify.email", params: { subject: "BINGO: {{summary}}", text: "{{summary}}" } });
    if (steps.length) {
      return { ...base, name: `On ${event.replace(/\./g, " ")}`, description: text, kind: "workflow", trigger: { type: "event", event, match: {} }, effect: { workflow: steps } };
    }
  }

  // "Always send a preview before publishing" → already enforced by policy
  if (/preview before (publishing|production|going live)/.test(t)) {
    return { ...base, name: "Preview before publishing", description: text, kind: "policy", trigger: { type: "request", intents: ["build.landing"], match: {} }, effect: { note: "Already enforced: production deploys require a verified preview of the same revision and your approval." } };
  }

  // "Send all approved deployment results to Telegram" (no 'whenever')
  if (/deploy\w*[^.]*telegram|telegram[^.]*deploy/.test(t)) {
    return { ...base, name: "Deployment results to Telegram", description: text, kind: "workflow", trigger: { type: "event", event: "deployment.production.live", match: {} }, effect: { workflow: [{ type: "notify.telegram", params: { text: "✅ Live: {{project}} → {{url}}" } }] } };
  }

  // Preferences on requests: "Whenever I ask for <intent> [in <country>], <do>"
  const m = text.match(/(?:whenever|every time|each time|when|always)\b[^,]*?(?:ask|request)s?\s+(?:you\s+)?(?:for|to)\s+([^,]+),\s*(.+)$/i) ?? text.match(/^for (?:all )?([^,]+),\s*(?:always\s+)?(.+)$/i);
  if (m) {
    const subject = m[1]!;
    const action = m[2]!;
    const intent = intentOf(subject);
    if (intent) {
      const setParams: Record<string, unknown> = {};
      const lang = languageIn(action);
      if (lang) setParams.language = lang;
      const kits = await listBrandKits(ctx);
      const kit = kits.find((k) => action.toLowerCase().includes(k.name.toLowerCase()));
      if (kit && /design|brand|style|kit|system/.test(action.toLowerCase())) setParams.brandKitId = kit.id;
      const n = action.match(/\b(\d+)\s+(creatives?|variations?|concepts?|leads?|distributors?)/i);
      if (n) setParams.count = Number(n[1]);
      if (/story|reel/.test(action.toLowerCase()) && intent === "studio.creatives") setParams.formats = ["instagram-square", "story"];
      const country = countryIn(subject);
      if (Object.keys(setParams).length) {
        return { ...base, name: `Preference: ${subject.trim()}`, description: text, kind: "preference", trigger: { type: "request", intents: [intent], match: country ? { country } : {} }, effect: { setParams } };
      }
    }
  }

  return parseWithAi(ctx, text);
}

const AiSkillSchema = z.object({
  name: z.string(),
  kind: z.enum(["preference", "workflow"]),
  triggerType: z.enum(["request", "event"]),
  intents: z.array(z.enum(INTENTS)),
  event: z.string(),
  country: z.string(),
  language: z.string(),
  params: z.array(z.object({ key: z.string(), value: z.string() })),
  steps: z.array(z.object({ type: z.string(), title: z.string(), params: z.array(z.object({ key: z.string(), value: z.string() })) })),
});

async function parseWithAi(ctx: Ctx, text: string) {
  if (!(await route(ctx, "reasoning")).length) throw new Error("I could not map that instruction to a skill, and no reasoning model is connected to interpret it. Try phrasing it as “Whenever I ask for …, …” or “Whenever … is confirmed, …”.");
  const { data } = await callJson(
    ctx,
    {
      capability: "reasoning",
      system: `Convert an owner's instruction into a BINGO skill. Only use these step types: ${Object.keys(STEP_TYPES).join(", ")}. Only these events: ${EVENTS.join(", ")}. Leave fields empty ("" or []) when not applicable. Never create anything that changes approvals, permissions or security settings.`,
      prompt: text,
    },
    AiSkillSchema,
    { purpose: "skills.parse" },
  );
  const kv = (arr: { key: string; value: string }[]) => Object.fromEntries(arr.map((p) => [p.key, /^\d+$/.test(p.value) ? Number(p.value) : p.value]));
  return {
    createdFrom: text,
    name: data.name,
    description: text,
    kind: data.kind,
    trigger: data.triggerType === "event" ? { type: "event" as const, event: data.event as BingoEvent, match: {} } : { type: "request" as const, intents: data.intents, match: { ...(data.country ? { country: data.country } : {}), ...(data.language ? { language: data.language } : {}) } },
    effect: data.kind === "workflow" ? { workflow: data.steps.map((s) => ({ type: s.type, title: s.title, params: kv(s.params) })) } : { setParams: kv(data.params) },
  };
}

const FORBIDDEN_PARAMS = ["approvalId", "mode", "policy", "permissions", "token", "apiKey", "password", "secret"];

export function validateSkill(s: Pick<Skill, "trigger" | "effect" | "kind">): Skill["validation"] {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (s.trigger.type === "request") {
    if (!s.trigger.intents.length) errors.push("No request type to match");
    for (const i of s.trigger.intents) if (!(INTENTS as readonly string[]).includes(i)) errors.push(`Unknown request type ${i}`);
  } else if (!(EVENTS as readonly string[]).includes(s.trigger.event)) errors.push(`Unknown event ${s.trigger.event}`);
  const steps = [...(s.effect.addSteps ?? []), ...(s.effect.workflow ?? [])];
  for (const st of steps) {
    const info = STEP_TYPES[st.type];
    if (!info) {
      errors.push(`Unknown step type "${st.type}" — new executable abilities must be built and approved in BINGO BUILD`);
      continue;
    }
    for (const k of Object.keys(st.params)) {
      if (FORBIDDEN_PARAMS.includes(k)) errors.push(`Step ${st.type} may not set "${k}"`);
      else if (!info.params.includes(k) && !["productName"].includes(k)) warnings.push(`Step ${st.type}: parameter "${k}" is ignored`);
    }
    if (info.external) warnings.push(`${info.label} acts outside BINGO — it still follows your approval policy each time`);
  }
  for (const k of Object.keys(s.effect.setParams ?? {})) if (FORBIDDEN_PARAMS.includes(k)) errors.push(`A preference may not set "${k}"`);
  if (s.kind === "workflow" && !steps.length) errors.push("Workflow has no steps");
  if (s.kind === "preference" && !Object.keys(s.effect.setParams ?? {}).length) errors.push("Preference changes nothing");
  return { ok: errors.length === 0, errors, warnings };
}

export async function learnSkill(ctx: Ctx, instruction: string, actor = "owner"): Promise<Skill> {
  const parsed = await parseSkillInstruction(ctx, instruction);
  const validation = validateSkill(parsed);
  const now = ctx.now().toISOString();
  // Same trigger → new version of the existing skill instead of a duplicate.
  const existing = (await listSkills(ctx)).find((s) => JSON.stringify(s.trigger) === JSON.stringify(parsed.trigger) && s.kind === parsed.kind && s.status !== "disabled");
  const skill: Skill = existing
    ? { ...existing, ...parsed, version: existing.version + 1, updatedAt: now, validation, status: validation.ok ? "active" : "draft" }
    : { ...parsed, id: newId("skl"), status: validation.ok ? "active" : "draft", version: 1, createdAt: now, updatedAt: now, uses: 0, feedback: [], validation };
  await ctx.store.put("skills", skill);
  await logActivity(ctx, { actor, action: "skills.learned", summary: `${validation.ok ? "Saved" : "Drafted (needs fixing)"} skill “${skill.name}” v${skill.version}`, level: validation.ok ? "success" : "warning", ref: { kind: "skill", id: skill.id } });
  return skill;
}

export async function listSkills(ctx: Ctx) {
  return ctx.store.list<Skill>("skills");
}

export async function updateSkill(ctx: Ctx, id: string, patch: Partial<Pick<Skill, "name" | "status" | "effect" | "trigger" | "description">>) {
  const s = await ctx.store.get<Skill>("skills", id);
  if (!s) throw new Error("Skill not found");
  const next = { ...s, ...patch, version: s.version + 1, updatedAt: ctx.now().toISOString() };
  next.validation = validateSkill(next);
  if (!next.validation.ok && next.status === "active") next.status = "draft";
  await ctx.store.put("skills", next);
  return next;
}

export async function skillFeedback(ctx: Ctx, id: string, text: string, rating: -1 | 0 | 1) {
  const s = await ctx.store.get<Skill>("skills", id);
  if (!s) throw new Error("Skill not found");
  const next = { ...s, feedback: [...s.feedback, { at: ctx.now().toISOString(), text, rating }] };
  // Explicit corrections ("use Russian instead") update the preference.
  const lang = languageIn(text) ?? (text.match(/use (\w+) instead/i)?.[1] ? LANG_WORDS[text.match(/use (\w+) instead/i)![1]!.toLowerCase()] : undefined);
  if (lang && next.kind === "preference") (next.effect = { ...next.effect, setParams: { ...(next.effect.setParams ?? {}), language: lang } }), (next.version += 1);
  if (rating < 0 && s.feedback.filter((f) => f.rating < 0).length >= 2) next.status = "disabled";
  await ctx.store.put("skills", next);
  return next;
}

export interface AppliedPreferences {
  params: Record<string, unknown>;
  addSteps: StepTemplate[];
  applied: { id: string; name: string; version: number }[];
  notes: string[];
}

export async function applyPreferences(ctx: Ctx, intent: Intent, context: { country?: string; language?: string; text: string }): Promise<AppliedPreferences> {
  const out: AppliedPreferences = { params: {}, addSteps: [], applied: [], notes: [] };
  for (const s of await listSkills(ctx)) {
    if (s.status !== "active" || s.trigger.type !== "request" || !s.trigger.intents.includes(intent)) continue;
    const m = s.trigger.match;
    if (m.country && m.country !== context.country) continue;
    if (m.language && m.language !== context.language) continue;
    if (m.keywords?.length && !m.keywords.some((k) => context.text.toLowerCase().includes(k.toLowerCase()))) continue;
    Object.assign(out.params, s.effect.setParams ?? {});
    out.addSteps.push(...(s.effect.addSteps ?? []));
    if (s.effect.note) out.notes.push(s.effect.note);
    out.applied.push({ id: s.id, name: s.name, version: s.version });
    await ctx.store.put("skills", { ...s, uses: s.uses + 1 });
  }
  return out;
}

function fill(v: unknown, data: Record<string, unknown>): unknown {
  if (typeof v === "string") return v.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(data[k] ?? ""));
  if (Array.isArray(v)) return v.map((x) => fill(x, data));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, data)]));
  return v;
}

/** Fires event-triggered skills as durable workflows. */
export async function emitEvent(ctx: Ctx, event: BingoEvent, data: Record<string, unknown>): Promise<string[]> {
  const started: string[] = [];
  const skills = (await listSkills(ctx)).filter((s) => s.status === "active" && s.trigger.type === "event" && s.trigger.event === event);
  for (const s of skills) {
    const match = s.trigger.type === "event" ? s.trigger.match : {};
    if (!Object.entries(match).every(([k, v]) => String(data[k] ?? "") === v)) continue;
    try {
      const { createWorkflow } = await import("@/orchestrator/workflow");
      const vars = { ...data, event, id: String(data.meetingId ?? data.id ?? data.projectId ?? ""), skillName: s.name };
      const steps = (s.effect.workflow ?? []).map((st) => ({ ...st, params: fill(st.params, vars) as Record<string, unknown> }));
      const wf = await createWorkflow(ctx, { goal: `${s.name} (${event})`, steps, source: { kind: "skill", id: s.id }, workspaceId: String(data.workspaceId ?? "") || undefined });
      started.push(wf.id);
      await ctx.store.put("skills", { ...s, uses: s.uses + 1 });
    } catch (e) {
      await logActivity(ctx, { actor: "bingo", action: "skills.error", summary: `Skill “${s.name}” failed to start: ${errorMessage(e)}`, level: "error" });
    }
  }
  return started;
}
