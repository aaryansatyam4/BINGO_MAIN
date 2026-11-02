import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { errorMessage } from "@/core/util";
import { PROVIDERS, SUGGESTED_DEFAULTS, descriptor, providersFor } from "./catalog";
import { anthropicAdapter } from "./providers/anthropic";
import { deeplAdapter, geminiAdapter, googleTranslateAdapter, openaiAdapter } from "./providers/others";
import {
  BudgetExceededError,
  CAPABILITY_LABELS,
  CapabilityUnavailableError,
  ModelRefusalError,
  type AdapterCreds,
  type Capability,
  type ImageEditRequest,
  type ImageRequest,
  type ImageResult,
  type LanguageCapability,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderConnection,
  type ProviderId,
  type ResearchResult,
  type TextRequest,
  type TextResult,
  type ToolLoopRequest,
  type ToolLoopResult,
  type TranslateRequest,
  type TranslateResult,
  type Usage,
} from "./types";

/**
 * BINGO AI ENGINE — one gateway over many providers.
 *
 * route(): picks provider+model per capability using what is connected and
 * enabled, the owner's preferred/fallback choices, price, measured latency and
 * measured reliability, monthly spending limits and workspace permissions.
 * call*(): executes with automatic fallback and records cost & reliability.
 */

export type AdapterFactory = (ctx: Ctx, id: ProviderId) => ProviderAdapter;

export const defaultAdapters: AdapterFactory = (ctx, id) => {
  switch (id) {
    case "anthropic":
      return anthropicAdapter(ctx);
    case "openai":
      return openaiAdapter(ctx);
    case "openai-compatible":
      return openaiAdapter(ctx, { id: "openai-compatible" });
    case "gemini":
      return geminiAdapter(ctx);
    case "google-translate":
      return googleTranslateAdapter(ctx);
    case "deepl":
      return deeplAdapter(ctx);
  }
};

let adapterFactory: AdapterFactory = defaultAdapters;
/** Tests replace provider implementations with fakes. */
export function setAdapterFactory(f: AdapterFactory | null) {
  adapterFactory = f ?? defaultAdapters;
}

// ---------------------------------------------------------------------------
// Connections (Settings → AI Models)
// ---------------------------------------------------------------------------

export async function listConnections(ctx: Ctx): Promise<ProviderConnection[]> {
  return ctx.store.list<ProviderConnection>("ai_connections", { newestFirst: false });
}

export async function getConnection(ctx: Ctx, id: ProviderId) {
  return ctx.store.get<ProviderConnection>("ai_connections", id);
}

export async function saveConnection(
  ctx: Ctx,
  id: ProviderId,
  input: { credentials?: AdapterCreds } & Partial<Omit<ProviderConnection, "id" | "createdAt">>,
): Promise<ProviderConnection> {
  const d = descriptor(id);
  const cur = await getConnection(ctx, id);
  if (input.credentials) {
    for (const f of d.credentialFields) {
      if (!f.optional && !input.credentials[f.key] && !cur) throw new Error(`${d.name}: "${f.label}" is required.`);
    }
    const existing = (await ctx.vault.getJson<AdapterCreds>("global", `ai:${id}`)) ?? {};
    const merged = { ...existing };
    for (const [k, v] of Object.entries(input.credentials)) if (v) merged[k] = v;
    await ctx.vault.setJson("global", `ai:${id}`, merged, { provider: id });
  }
  const supported = [...new Set(d.models.flatMap((m) => m.capabilities))];
  const next: ProviderConnection = {
    id,
    enabled: input.enabled ?? cur?.enabled ?? true,
    capabilities: (input.capabilities ?? cur?.capabilities ?? supported).filter((c) => supported.includes(c)),
    monthlyLimitUsd: input.monthlyLimitUsd ?? cur?.monthlyLimitUsd ?? 50,
    preferred: input.preferred ?? cur?.preferred ?? { ...(SUGGESTED_DEFAULTS[id] ?? {}) },
    fallbacks: input.fallbacks ?? cur?.fallbacks ?? {},
    models: input.models ?? cur?.models,
    allowedWorkspaces: input.allowedWorkspaces ?? cur?.allowedWorkspaces,
    lastTest: cur?.lastTest,
    createdAt: cur?.createdAt ?? ctx.now().toISOString(),
  };
  await ctx.store.put("ai_connections", next);
  return next;
}

export async function removeConnection(ctx: Ctx, id: ProviderId) {
  await ctx.vault.revoke("global", `ai:${id}`);
  await ctx.store.delete("ai_connections", id);
  await logActivity(ctx, { actor: "owner", action: "ai.connection.removed", summary: `Removed ${descriptor(id).name} and revoked its stored credentials`, level: "warning" });
}

async function credsFor(ctx: Ctx, id: ProviderId): Promise<AdapterCreds | null> {
  return ctx.vault.getJson<AdapterCreds>("global", `ai:${id}`);
}

export async function testConnection(ctx: Ctx, id: ProviderId) {
  const cur = await getConnection(ctx, id);
  if (!cur) throw new Error("Connect the provider first.");
  const creds = await credsFor(ctx, id);
  let result: { ok: boolean; detail: string; models?: string[] };
  if (!creds) result = { ok: false, detail: "No credentials stored." };
  else {
    try {
      result = await adapterFactory(ctx, id).test(creds);
    } catch (e) {
      result = { ok: false, detail: errorMessage(e) };
    }
  }
  await ctx.store.put("ai_connections", { ...cur, lastTest: { ...result, at: ctx.now().toISOString() } });
  return result;
}

function modelsOf(conn: ProviderConnection): ModelInfo[] {
  const base = descriptor(conn.id).models;
  if (!conn.models?.length) return base;
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const m of conn.models) byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Metrics & spend
// ---------------------------------------------------------------------------

interface Metric {
  id: string;
  provider: ProviderId;
  model: string;
  capability: Capability;
  success: number;
  failure: number;
  ewmaLatencyMs: number;
  lastError?: string;
  lastAt: string;
}

interface Spend {
  id: string; // provider:YYYY-MM
  provider: ProviderId;
  month: string;
  usd: number;
  calls: number;
}

const month = (ctx: Ctx) => ctx.now().toISOString().slice(0, 7);

/** Per-workflow-step usage accounting (resource usage shown in the execution plan). */
export interface UsageScope {
  costUsd: number;
  calls: number;
  models: Set<string>;
}
const usageStore = new AsyncLocalStorage<UsageScope>();
export async function withUsageScope<T>(fn: () => Promise<T>): Promise<{ value: T; usage: UsageScope }> {
  const scope: UsageScope = { costUsd: 0, calls: 0, models: new Set() };
  const value = await usageStore.run(scope, fn);
  return { value, usage: scope };
}

async function record(ctx: Ctx, provider: ProviderId, model: string, capability: Capability, ok: boolean, latencyMs: number, usage?: Usage, err?: string, workspaceId?: string) {
  const id = `${provider}:${model}:${capability}`;
  const m: Metric = (await ctx.store.get<Metric>("ai_metrics", id)) ?? { id, provider, model, capability, success: 0, failure: 0, ewmaLatencyMs: latencyMs, lastAt: "" };
  m.success += ok ? 1 : 0;
  m.failure += ok ? 0 : 1;
  m.ewmaLatencyMs = Math.round(m.ewmaLatencyMs * 0.7 + latencyMs * 0.3);
  m.lastAt = ctx.now().toISOString();
  if (err) m.lastError = err.slice(0, 300);
  await ctx.store.put("ai_metrics", m);
  const scope = usageStore.getStore();
  if (scope && ok) {
    scope.calls += 1;
    scope.costUsd += usage?.costUsd ?? 0;
    scope.models.add(`${provider}/${model}`);
  }
  if (usage && usage.costUsd > 0) {
    const sid = `${provider}:${month(ctx)}`;
    const s = (await ctx.store.get<Spend>("ai_spend", sid)) ?? { id: sid, provider, month: month(ctx), usd: 0, calls: 0 };
    s.usd += usage.costUsd;
    s.calls += 1;
    await ctx.store.put("ai_spend", s);
    await ctx.store.put("usage_ledger", { id: `${sid}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`, provider, model, capability, workspaceId: workspaceId ?? null, at: ctx.now().toISOString(), ...usage });
  }
}

export async function spendThisMonth(ctx: Ctx, provider: ProviderId): Promise<number> {
  return (await ctx.store.get<Spend>("ai_spend", `${provider}:${month(ctx)}`))?.usd ?? 0;
}

export async function listMetrics(ctx: Ctx) {
  return ctx.store.list<Metric>("ai_metrics");
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface RouteCandidate {
  provider: ProviderId;
  model: ModelInfo;
  score: number;
  reasons: string[];
}

export interface RouteOptions {
  workspaceId?: string;
  /** Prefer cheaper models (simple tasks) or quality (complex tasks). */
  priority?: "quality" | "balanced" | "economy";
  needsMethod?: keyof ProviderAdapter;
}

const METHOD_FOR: Record<Capability, keyof ProviderAdapter> = {
  reasoning: "text",
  coding: "text",
  copywriting: "text",
  classification: "text",
  translation: "text",
  research: "research",
  vision: "text",
  "image.generate": "image",
  "image.edit": "editImage",
  "speech.tts": "tts",
  "speech.stt": "text",
};

export async function route(ctx: Ctx, capability: Capability, opts: RouteOptions = {}): Promise<RouteCandidate[]> {
  const conns = (await listConnections(ctx)).filter((c) => c.enabled && c.capabilities.includes(capability));
  const method = opts.needsMethod ?? METHOD_FOR[capability];
  const priority = opts.priority ?? (capability === "classification" ? "economy" : "quality");
  const out: RouteCandidate[] = [];
  for (const conn of conns) {
    if (opts.workspaceId && conn.allowedWorkspaces?.length && !conn.allowedWorkspaces.includes(opts.workspaceId)) continue;
    if (!(await credsFor(ctx, conn.id))) continue;
    const adapter = adapterFactory(ctx, conn.id);
    // Translation APIs translate; LLMs translate through text().
    const hasMethod = capability === "translation" ? !!(adapter.translate || adapter.text) : !!adapter[method];
    if (!hasMethod) continue;
    const spent = await spendThisMonth(ctx, conn.id);
    if (spent >= conn.monthlyLimitUsd) continue;
    for (const model of modelsOf(conn).filter((m) => m.capabilities.includes(capability))) {
      const metric = await ctx.store.get<Metric>("ai_metrics", `${conn.id}:${model.id}:${capability}`);
      const reliability = metric ? (metric.success + 1) / (metric.success + metric.failure + 2) : 0.8;
      const latency = metric?.ewmaLatencyMs ?? model.latencyMs;
      const unitCost = (model.inputPer1M ?? 0) + (model.outputPer1M ?? 0) / 2 + (model.perImage ?? 0) * 20 + (model.perMillionChars ?? 0) / 4;
      const costScore = 1 / (1 + unitCost / 5);
      const latencyScore = 1 / (1 + latency / 5000);
      const w = priority === "quality" ? { q: 0.55, r: 0.25, c: 0.1, l: 0.1 } : priority === "economy" ? { q: 0.2, r: 0.25, c: 0.4, l: 0.15 } : { q: 0.4, r: 0.25, c: 0.2, l: 0.15 };
      let score = w.q * model.quality + w.r * reliability + w.c * costScore + w.l * latencyScore;
      const reasons = [`quality ${model.quality.toFixed(2)}`, `reliability ${(reliability * 100).toFixed(0)}%`, `~${Math.round(latency)}ms`];
      if (conn.preferred[capability] === model.id) {
        score += 0.5;
        reasons.unshift("your preferred model");
      }
      const fbIndex = conn.fallbacks[capability]?.indexOf(model.id) ?? -1;
      if (fbIndex >= 0) {
        score += 0.2 - fbIndex * 0.02;
        reasons.unshift(`your fallback #${fbIndex + 1}`);
      }
      out.push({ provider: conn.id, model, score, reasons });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function explainMissing(ctx: Ctx, capability: Capability): Promise<string> {
  const options = providersFor(capability).map((p) => p.name);
  const conns = await listConnections(ctx);
  const disabled = conns.filter((c) => !c.enabled || !c.capabilities.includes(capability)).filter((c) => descriptor(c.id).models.some((m) => m.capabilities.includes(capability)));
  const overBudget: string[] = [];
  for (const c of conns) if ((await spendThisMonth(ctx, c.id)) >= c.monthlyLimitUsd) overBudget.push(descriptor(c.id).name);
  let msg = `${CAPABILITY_LABELS[capability]} needs a connected provider that supports it (${options.join(", ")}). Add credentials in Settings → AI Models.`;
  if (disabled.length) msg += ` ${disabled.map((c) => descriptor(c.id).name).join(", ")} is connected but this capability is switched off.`;
  if (overBudget.length) msg += ` Monthly spending limit reached for: ${overBudget.join(", ")}.`;
  return msg;
}

// ---------------------------------------------------------------------------
// Execution with fallback
// ---------------------------------------------------------------------------

export interface CallMeta {
  workspaceId?: string;
  purpose: string;
  priority?: RouteOptions["priority"];
}

async function withFallback<T extends { usage: Usage }>(
  ctx: Ctx,
  capability: Capability,
  meta: CallMeta,
  run: (adapter: ProviderAdapter, model: ModelInfo, creds: AdapterCreds) => Promise<T>,
  needsMethod?: keyof ProviderAdapter,
): Promise<T & { provider: ProviderId; modelId: string; attempts: string[] }> {
  const candidates = await route(ctx, capability, { workspaceId: meta.workspaceId, priority: meta.priority, needsMethod });
  if (!candidates.length) throw new CapabilityUnavailableError(capability, await explainMissing(ctx, capability));
  const attempts: string[] = [];
  const tried = new Set<string>();
  for (const c of candidates.slice(0, 4)) {
    if (tried.has(`${c.provider}:${c.model.id}`)) continue;
    tried.add(`${c.provider}:${c.model.id}`);
    const conn = (await getConnection(ctx, c.provider))!;
    if ((await spendThisMonth(ctx, c.provider)) >= conn.monthlyLimitUsd) {
      attempts.push(`${c.provider}/${c.model.id}: monthly limit reached`);
      continue;
    }
    const creds = (await credsFor(ctx, c.provider))!;
    const started = Date.now();
    try {
      const res = await run(adapterFactory(ctx, c.provider), c.model, creds);
      await record(ctx, c.provider, c.model.id, capability, true, Date.now() - started, res.usage, undefined, meta.workspaceId);
      return { ...res, provider: c.provider, modelId: c.model.id, attempts };
    } catch (e) {
      const msg = errorMessage(e);
      await record(ctx, c.provider, c.model.id, capability, false, Date.now() - started, undefined, msg, meta.workspaceId);
      attempts.push(`${c.provider}/${c.model.id}: ${msg}`);
      if (e instanceof ModelRefusalError) continue; // try a different provider
    }
  }
  const hasLimit = attempts.some((a) => a.includes("monthly limit"));
  const err = `All providers failed for ${CAPABILITY_LABELS[capability]} (${meta.purpose}): ${attempts.join(" | ")}`;
  throw hasLimit && attempts.every((a) => a.includes("monthly limit")) ? new BudgetExceededError(err) : new Error(err);
}

export async function callText(ctx: Ctx, req: TextRequest, meta: CallMeta) {
  return withFallback<TextResult>(ctx, req.capability, meta, (a, m, c) => a.text!(m, req, c), "text");
}

/** Structured output validated with zod. Uses provider-native JSON schema where supported. */
export async function callJson<S extends z.ZodType>(ctx: Ctx, req: Omit<TextRequest, "jsonSchema">, schema: S, meta: CallMeta): Promise<{ data: z.infer<S>; provider: ProviderId; modelId: string; usage: Usage }> {
  const jsonSchema = toProviderSchema(schema);
  const res = await withFallback<TextResult & { data: z.infer<S> }>(
    ctx,
    req.capability,
    meta,
    async (a, m, c) => {
      const r = await a.text!(m, { ...req, jsonSchema }, c);
      const raw = extractJson(r.text);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new Error(`Model output did not match the expected structure: ${parsed.error.message.slice(0, 300)}`);
      return { ...r, data: parsed.data };
    },
    "text",
  );
  return { data: res.data, provider: res.provider, modelId: res.modelId, usage: res.usage };
}

export async function callResearch(ctx: Ctx, query: string, meta: CallMeta & { maxUses?: number; system?: string }) {
  return withFallback<ResearchResult>(ctx, "research", meta, (a, m, c) => a.research!(m, query, { maxUses: meta.maxUses ?? 8, system: meta.system }, c), "research");
}

export async function callToolLoop(ctx: Ctx, capability: Capability, req: ToolLoopRequest, meta: CallMeta) {
  return withFallback<ToolLoopResult>(ctx, capability, meta, (a, m, c) => a.toolLoop!(m, req, c), "toolLoop");
}

export async function callImage(ctx: Ctx, req: ImageRequest, meta: CallMeta) {
  return withFallback<ImageResult>(ctx, "image.generate", meta, (a, m, c) => a.image!(m, req, c), "image");
}

export async function callImageEdit(ctx: Ctx, req: ImageEditRequest, meta: CallMeta) {
  return withFallback<ImageResult>(ctx, "image.edit", meta, (a, m, c) => a.editImage!(m, req, c), "editImage");
}

/** Translation: dedicated translation APIs first, LLMs as fallback (or the other way round if preferred). */
export async function callTranslate(ctx: Ctx, req: TranslateRequest, meta: CallMeta) {
  return withFallback<TranslateResult>(
    ctx,
    "translation",
    meta,
    async (a, m, c) => {
      if (a.translate) return a.translate(m, req, c);
      const schema = z.object({ translations: z.array(z.string()) });
      const r = await a.text!(
        m,
        {
          capability: "translation",
          system:
            "You are a professional business translator. Translate faithfully. Keep every ⟦n⟧ placeholder exactly as written. Do not add or omit information. Preserve names, numbers, units and technical terms.",
          prompt: `Target language (BCP-47): ${req.target}${req.source ? `\nSource language: ${req.source}` : ""}\nTranslate each string in this JSON array and answer {"translations": [...]} in the same order:\n${JSON.stringify(req.texts)}`,
          jsonSchema: toProviderSchema(schema),
        },
        c,
      );
      const parsed = schema.parse(extractJson(r.text));
      if (parsed.translations.length !== req.texts.length) throw new Error("Translation count mismatch");
      return { texts: parsed.translations, usage: r.usage, model: r.model };
    },
    "text",
  );
}

/** Union of languages reported by connected translation providers (+ LLM coverage). */
export async function discoverLanguages(ctx: Ctx): Promise<{ provider: ProviderId; languages: LanguageCapability[] }[]> {
  const out: { provider: ProviderId; languages: LanguageCapability[] }[] = [];
  for (const conn of await listConnections(ctx)) {
    if (!conn.enabled) continue;
    const adapter = adapterFactory(ctx, conn.id);
    const creds = await credsFor(ctx, conn.id);
    if (!adapter.languages || !creds) continue;
    try {
      out.push({ provider: conn.id, languages: await adapter.languages(creds) });
    } catch (e) {
      await logActivity(ctx, { actor: "bingo", action: "lang.discovery.failed", summary: `${conn.id}: ${errorMessage(e)}`, level: "warning" });
    }
  }
  return out;
}

export function availableProviders() {
  return PROVIDERS;
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/** zod → JSON Schema restricted to what provider structured-output modes accept. */
export function toProviderSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "pattern", "format", "minItems", "maxItems", "default"].includes(k)) continue;
      o[k] = clean(v);
    }
    if (o.type === "object" && o.properties) {
      o.additionalProperties = false;
      o.required = Object.keys(o.properties as object);
    }
    return o;
  };
  return clean(raw) as Record<string, unknown>;
}

export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return JSON.parse(fenced[1]!);
    const start = t.search(/[[{]/);
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error("No JSON found in model output");
  }
}
