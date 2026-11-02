import { z } from "zod";
import type { Ctx } from "@/core/context";
import { callJson, route } from "@/ai/engine";
import { getOwner, resolveWorkspace } from "@/core/settings";
import { countryCode } from "@/global/crm";
import { inferKind, inferLocales } from "@/build/developer";
import { brandKitForWorkspace, findProduct } from "@/studio/brand";
import { FORMATS } from "@/studio/compose";
import { applyPreferences, type AppliedPreferences } from "@/skills/engine";
import { STEP_TYPES } from "./catalog";
import { createWorkflow, type NewStep, type Workflow } from "./workflow";

/**
 * Ask BINGO: turns one natural-language objective into a dependency-ordered
 * plan across modules (Research → Copy → Translation → Design → Code → Tests →
 * Preview → Approval → Production → Outreach → CRM → Reporting).
 * Common requests are understood deterministically; anything else is composed
 * by a reasoning model from the step catalogue and then validated.
 */
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50 };

function numberBefore(text: string, nouns: string): number | undefined {
  const m = text.toLowerCase().match(new RegExp(`\\b(\\d+|${Object.keys(NUMBER_WORDS).join("|")})\\s+(?:\\w+\\s+){0,3}?(?:${nouns})`));
  if (!m) return undefined;
  return /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!];
}

function countryFrom(text: string): string | undefined {
  for (const m of text.matchAll(/\b(?:in|for|from|to)\s+((?:[A-Z][a-z]+)(?:\s[A-Z][a-z]+)?)/g)) {
    const c = countryCode(m[1]!) ?? countryCode(m[1]!.split(" ")[0]!);
    if (c) return c;
  }
  return undefined;
}

const LANG: [RegExp, string][] = [
  [/\b(in )?russian\b/i, "ru"],
  [/\b(in )?hindi\b/i, "hi"],
  [/\b(in )?uzbek\b/i, "uz"],
  [/\b(in )?arabic\b/i, "ar"],
  [/\b(in )?french\b/i, "fr"],
  [/\b(in )?spanish\b/i, "es"],
  [/\b(in )?khmer\b/i, "km"],
  [/\b(in )?nepali\b/i, "ne"],
  [/\b(in )?english\b/i, "en"],
  [/\b(in )?(mandarin|chinese)\b/i, "zh"],
  [/\b(in )?tajik\b/i, "tg"],
  [/\b(in )?kyrgyz\b/i, "ky"],
  [/\b(in )?turkmen\b/i, "tk"],
  [/\b(in )?lao\b/i, "lo"],
];
const languageFrom = (t: string) => LANG.find(([re]) => re.test(t))?.[1];

export interface PlanResult {
  goal: string;
  workspaceId: string;
  steps: NewStep[];
  applied: AppliedPreferences["applied"];
  notes: string[];
  understoodBy: "rules" | "ai";
}

export async function planRequest(ctx: Ctx, text: string): Promise<PlanResult> {
  const t = text.toLowerCase();
  const w = await resolveWorkspace(ctx, text);
  const kit = await brandKitForWorkspace(ctx, w.id);
  const product = kit ? findProduct(kit, text) : null;
  const owner = await getOwner(ctx);
  const steps: NewStep[] = [];
  const notes: string[] = [];
  const applied: AppliedPreferences["applied"] = [];
  const country = countryFrom(text);
  const lang = languageFrom(text);

  // Skills / standing instructions
  if (/^(whenever|every time|each time|always|from now on)\b/i.test(text.trim()) || /\b(remember|save this as a skill)\b/.test(t)) {
    if (/\bcall me\b|telegram for routine|quiet hours|do not disturb/.test(t) && !/landing|website|creative/.test(t)) steps.push({ id: "policy", type: "speak.policy", params: { instruction: text } });
    else steps.push({ id: "skill", type: "skills.learn", params: { instruction: text } });
    return { goal: text, workspaceId: w.id, steps, applied, notes, understoodBy: "rules" };
  }
  if (/\bcall me\b.*(emergenc|critical|urgent|major)|routine (matters )?to telegram|do not disturb|quiet hours/.test(t)) {
    steps.push({ id: "policy", type: "speak.policy", params: { instruction: text } });
    return { goal: text, workspaceId: w.id, steps, applied, notes, understoodBy: "rules" };
  }

  const wantsSite = /\b(landing.?page|website|web ?site|web page|microsite|\bsite\b)/.test(t) && !/report/.test(t.split(/website|landing/)[0] ?? "");
  const wantsCreatives = /\b(creatives?|banners?|posters?|images?|graphics?|ad(vert(isement)?)?s?|instagram|visuals?|brochure|catalog)\b/.test(t);
  const wantsResearch = /\b(find|research|discover|identify|look for)\b[^.]*\b(distributors?|partners?|importers?|wholesalers?)\b|\bpotential (international )?distributors\b/.test(t);
  const wantsOutreach = /\b(outreach|introduction|introduce|emails?|contact|reach out|send)\b[^.]*\b(distributors?|leads?|them|partners)\b|\bprepare (our |an? )?(outreach|introduction)|\bin their language\b/.test(t);
  const wantsMeetings = /\b(meetings?|interviews?|schedule|calendar)\b/.test(t) && !/report/.test(t);
  const wantsReport = /\breport\b/.test(t);
  const wantsDeploy = /\b(deploy|vercel|publish|live|preview|production)\b/.test(t) || wantsSite;
  const sharePage = wantsSite && /\bsend (the )?(approved )?(page|site|website|link)\b|share (the )?(page|site)/.test(t);

  if (wantsSite) {
    const pref = await applyPreferences(ctx, "build.landing", { country, language: lang, text });
    applied.push(...pref.applied);
    notes.push(...pref.notes);
    const locales = pref.params.language ? [String(pref.params.language), ...inferLocales(text, owner.preferredLanguage).filter((l) => l !== pref.params.language)] : inferLocales(text, owner.preferredLanguage);
    steps.push(
      { id: "plan", type: "build.plan", params: { request: text, workspaceId: w.id, kind: inferKind(text), locales: [...new Set(locales)], productId: product?.id ?? null, ...(pref.params.brandKitId ? { brandKitId: pref.params.brandKitId } : {}) } },
      { id: "copy", type: "build.content", params: { projectId: { $ref: "plan.projectId" }, ...(country ? { market: country } : {}) } },
    );
    if (wantsCreatives) steps.push({ id: "creatives", type: "studio.generate", deps: [], params: { brief: `Website imagery and launch creatives: ${text}`, count: 2, formats: ["web-hero", "instagram-square"], productId: product?.id ?? null, workspaceId: w.id, ...(lang ? { language: lang } : {}) } });
    steps.push(
      { id: "code", type: "build.files", params: { projectId: { $ref: "copy.projectId" } } },
      { id: "test", type: "build.checks", params: { projectId: { $ref: "code.projectId" } } },
      { id: "git", type: "build.github", params: { projectId: { $ref: "test.projectId" } } },
    );
    if (wantsDeploy) {
      steps.push({ id: "preview", type: "build.preview", params: { projectId: { $ref: "test.projectId" } }, deps: ["git"] });
      steps.push({ id: "production", type: "build.production", params: { projectId: { $ref: "preview.projectId" } } });
    }
  } else if (wantsCreatives) {
    const pref = await applyPreferences(ctx, "studio.creatives", { country, language: lang, text });
    applied.push(...pref.applied);
    const formats = Object.keys(FORMATS).filter((f) => (t.includes("story") && f === "story") || (t.includes("instagram") && f.startsWith("instagram")) || (t.includes("banner") && f === "ecommerce-banner") || (t.includes("hero") && f === "web-hero") || (t.includes("email") && f === "email-header") || ((t.includes("poster") || t.includes("brochure")) && f === "a4-poster"));
    steps.push({ id: "creatives", type: "studio.generate", params: { brief: text, count: numberBefore(text, "creatives?|concepts?|ads?|banners?|posts?|variations?|images?") ?? (pref.params.count as number) ?? 3, formats: formats.length ? formats : ((pref.params.formats as string[]) ?? ["instagram-square", "instagram-portrait", "web-hero"]), productId: product?.id ?? null, workspaceId: w.id, ...(pref.params.brandKitId ? { brandKitId: pref.params.brandKitId } : {}), ...(lang ?? pref.params.language ? { language: lang ?? pref.params.language } : {}) } });
  }

  if (wantsResearch || (wantsOutreach && country)) {
    if (!country) notes.push("Which country? Add it to the request (e.g. “in Uzbekistan”).");
    else {
      const pref = await applyPreferences(ctx, "global.outreach", { country, language: lang, text });
      applied.push(...pref.applied);
      const segment = /pharma/.test(t) ? "pharmaceutical distributors and importers" : /nutra|supplement|wellness/.test(t) ? "nutraceutical and dietary supplement distributors" : "pharmaceutical and nutraceutical distributors";
      steps.push({ id: "research", type: "global.research", deps: [], params: { country, count: numberBefore(text, "distributors?|partners?|leads?|companies|importers?") ?? 20, segment, workspaceId: w.id } });
      if (wantsOutreach || sharePage) {
        const language = lang ?? (pref.params.language as string | undefined);
        if (!sharePage) {
          steps.push({ id: "draft", type: "global.draft", params: { leadIds: { $ref: "research.leadIds" }, ...(language ? { language } : {}) } });
          steps.push({ id: "send", type: "global.send", params: { messageIds: { $ref: "draft.messageIds" } } });
        }
      }
    }
  }
  if (sharePage) {
    const deps = ["production", ...(steps.some((s) => s.id === "research") ? ["research"] : [])];
    steps.push({ id: "share", type: "global.share_page", deps, params: { projectId: { $ref: "production.projectId" }, ...(steps.some((s) => s.id === "research") ? { leadIds: { $ref: "research.leadIds" } } : {}), ...(lang ? { language: lang } : {}) } });
    steps.push({ id: "send-share", type: "global.send", params: { messageIds: { $ref: "share.messageIds" } } });
  }
  if (wantsMeetings) {
    const after = steps.some((s) => s.id === "send") ? ["send"] : [];
    steps.push({ id: "meetings", type: "calendar.propose", deps: after, params: { leadIds: [], objective: /interview/.test(t) ? "Interview" : "Introductory call about distribution partnership" } });
    steps.push({ id: "send-invites", type: "global.send", params: { messageIds: { $ref: "meetings.messageIds" } } });
  }
  if (wantsReport) {
    const channels = [...(/gmail|email|mail/.test(t) ? ["email"] : []), ...(/telegram/.test(t) ? ["telegram"] : [])];
    steps.push({ id: "report", type: "report.generate", deps: [], params: { topic: text, country: country ?? undefined, language: lang ?? owner.preferredLanguage, workspaceId: w.id } });
    steps.push({ id: "deliver", type: "report.deliver", params: { reportId: { $ref: "report.reportId" }, channels: channels.length ? channels : ["email", "telegram"] } });
  }
  if (/\b(follow.?up )?tasks?\b.*\b(sheet|task)/.test(t) || /create (a )?(follow.?up )?task/.test(t)) {
    steps.push({ id: "task", type: "tasks.create", deps: steps.length ? [steps.at(-1)!.id!] : [], params: { ref: `ask:${Date.now()}`, kind: "general", title: text.slice(0, 120), details: text, deadlineDays: 3 } });
  }
  if (/call me if|call me when/.test(t)) notes.push("Critical decisions are escalated by phone according to your escalation policy (BINGO SPEAK).");

  if (steps.length) {
    // Implicit sequencing: a step without explicit deps waits for the previous step.
    steps.forEach((s, i) => {
      if (s.deps === undefined && i > 0 && !hasRef(s.params)) s.deps = [steps[i - 1]!.id!];
    });
    return { goal: text, workspaceId: w.id, steps, applied, notes, understoodBy: "rules" };
  }
  return planWithAi(ctx, text, w.id, notes);
}

function hasRef(p: Record<string, unknown>) {
  return JSON.stringify(p).includes('"$ref"');
}

const AiPlanSchema = z.object({
  steps: z.array(z.object({ id: z.string(), type: z.string(), deps: z.array(z.string()), params: z.array(z.object({ key: z.string(), value: z.string() })) })),
  clarification: z.string(),
});

async function planWithAi(ctx: Ctx, text: string, workspaceId: string, notes: string[]): Promise<PlanResult> {
  if (!(await route(ctx, "reasoning")).length) {
    return { goal: text, workspaceId, steps: [], applied: [], notes: [...notes, "I could not map this request to my built-in workflows, and no reasoning model is connected to plan it. Connect Claude in Settings → AI Models, or rephrase (e.g. “create a landing page for …”, “find 20 distributors in …”)."], understoodBy: "rules" };
  }
  const catalogue = Object.entries(STEP_TYPES).map(([k, v]) => `${k}: ${v.label} (params: ${v.params.join(", ")})`).join("\n");
  const { data } = await callJson(
    ctx,
    {
      capability: "reasoning",
      system: `You are BINGO's orchestrator. Compose a plan using ONLY these step types:\n${catalogue}\nReference another step's output with the value "$ref:<stepId>.<field>" (fields: projectId, leadIds, messageIds, reportId, creativeIds, liveUrl). External actions are approval-gated automatically; do not add approval steps. If the request is unclear or impossible with these steps, return no steps and a clarification question.`,
      prompt: text,
    },
    AiPlanSchema,
    { purpose: "orchestrator.plan", workspaceId },
  );
  const steps: NewStep[] = data.steps
    .filter((s) => STEP_TYPES[s.type])
    .map((s) => ({
      id: s.id,
      type: s.type,
      deps: s.deps,
      params: Object.fromEntries(s.params.filter((p) => STEP_TYPES[s.type]!.params.includes(p.key)).map((p) => [p.key, p.value.startsWith("$ref:") ? { $ref: p.value.slice(5) } : /^\d+$/.test(p.value) ? Number(p.value) : p.value])),
    }));
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) s.deps = (s.deps ?? []).filter((d) => ids.has(d));
  if (data.clarification) notes.push(data.clarification);
  return { goal: text, workspaceId, steps, applied: [], notes, understoodBy: "ai" };
}

export async function askBingo(ctx: Ctx, text: string): Promise<{ workflow: Workflow | null; plan: PlanResult }> {
  const plan = await planRequest(ctx, text);
  if (!plan.steps.length) return { workflow: null, plan };
  const workflow = await createWorkflow(ctx, { goal: plan.goal, request: text, steps: plan.steps, source: { kind: "ask" }, workspaceId: plan.workspaceId, appliedSkills: plan.applied, notes: plan.notes });
  return { workflow, plan };
}
