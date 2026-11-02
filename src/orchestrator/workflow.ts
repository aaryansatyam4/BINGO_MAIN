import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { isSuspended, type Approval } from "@/core/policy";
import { releaseLease, tryLease } from "@/core/store";
import { errorMessage, getPath, newId } from "@/core/util";
import { withUsageScope } from "@/ai/engine";
import { STEP_TYPES, type StepTemplate } from "./catalog";

/**
 * Durable workflow engine. Workflows live in the database and are advanced by
 * the 24/7 runner (Vercel Cron → /api/cron/tick, or the worker), so they keep
 * going when the browser is closed. Every step is idempotent and resumable.
 */
export type StepStatus = "pending" | "running" | "waiting" | "waiting_approval" | "blocked" | "done" | "failed" | "skipped" | "cancelled";
export type WorkflowStatus = "running" | "paused" | "completed" | "failed" | "cancelled" | "needs_attention";

export interface Step {
  id: string;
  type: string;
  title: string;
  params: Record<string, unknown>;
  deps: string[];
  status: StepStatus;
  attempts: number;
  result?: Record<string, unknown>;
  summary?: string;
  error?: string;
  approvalId?: string;
  resumeAt?: string;
  state?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  usage: { aiUsd: number; aiCalls: number; models: string[]; ms: number };
}

export interface Workflow {
  id: string;
  goal: string;
  request?: string;
  workspaceId?: string;
  status: WorkflowStatus;
  steps: Step[];
  source: { kind: "ask" | "skill" | "schedule" | "ui"; id?: string };
  appliedSkills: { id: string; name: string; version: number }[];
  notes: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type StepOutcome =
  | { status: "done"; result?: Record<string, unknown>; summary: string }
  | { status: "waiting"; resumeAt: Date; summary: string; state?: Record<string, unknown> }
  | { status: "needs_approval"; approvalId: string; summary: string }
  | { status: "blocked"; summary: string };

export interface StepContext {
  ctx: Ctx;
  workflow: Workflow;
  step: Step;
  params: Record<string, unknown>;
}

export type StepHandler = (sc: StepContext) => Promise<StepOutcome>;

const TERMINAL: StepStatus[] = ["done", "failed", "skipped", "cancelled"];
const MAX_ATTEMPTS = 3;

export interface NewStep extends StepTemplate {
  id?: string;
  deps?: string[];
}

/** Resolves "$prev.x" and {"$ref":"stepId.path"} references into explicit dependencies. */
export function buildSteps(templates: NewStep[]): Step[] {
  const steps: Step[] = [];
  templates.forEach((t, i) => {
    const id = t.id ?? `s${i + 1}`;
    const deps = new Set(t.deps ?? []);
    const params = JSON.parse(JSON.stringify(t.params ?? {}), (_k, v) => {
      if (typeof v === "string" && v.startsWith("$prev.") && i > 0) {
        const prevId = steps[i - 1]!.id;
        deps.add(prevId);
        return { $ref: `${prevId}.${v.slice(6)}` };
      }
      if (v && typeof v === "object" && typeof v.$ref === "string") deps.add(v.$ref.split(".")[0]);
      return v;
    });
    if (!STEP_TYPES[t.type]) throw new Error(`Unknown step type ${t.type}`);
    steps.push({ id, type: t.type, title: t.title ?? STEP_TYPES[t.type]!.label, params, deps: [...deps], status: "pending", attempts: 0, usage: { aiUsd: 0, aiCalls: 0, models: [], ms: 0 } });
  });
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) for (const d of s.deps) if (!ids.has(d)) throw new Error(`Step ${s.id} depends on unknown step ${d}`);
  return steps;
}

export async function createWorkflow(ctx: Ctx, input: { goal: string; request?: string; steps: NewStep[]; source: Workflow["source"]; workspaceId?: string; appliedSkills?: Workflow["appliedSkills"]; notes?: string[] }): Promise<Workflow> {
  const now = ctx.now().toISOString();
  const wf: Workflow = {
    id: newId("wf"),
    goal: input.goal,
    request: input.request,
    workspaceId: input.workspaceId,
    status: "running",
    steps: buildSteps(input.steps),
    source: input.source,
    appliedSkills: input.appliedSkills ?? [],
    notes: input.notes ?? [],
    createdAt: now,
    updatedAt: now,
  };
  await ctx.store.put("workflows", wf);
  await logActivity(ctx, { actor: input.source.kind === "skill" ? `skill:${input.source.id}` : "owner", action: "workflow.created", summary: `Started: ${wf.goal} (${wf.steps.length} steps)`, workspaceId: wf.workspaceId, ref: { kind: "workflow", id: wf.id } });
  return wf;
}

export async function getWorkflow(ctx: Ctx, id: string) {
  return ctx.store.get<Workflow>("workflows", id);
}

export async function listWorkflows(ctx: Ctx, limit = 50) {
  return ctx.store.list<Workflow>("workflows", { limit });
}

function resolveParams(params: Record<string, unknown>, steps: Step[]): Record<string, unknown> {
  return JSON.parse(JSON.stringify(params), (_k, v) => {
    if (v && typeof v === "object" && typeof v.$ref === "string") {
      const [sid, ...path] = v.$ref.split(".");
      const s = steps.find((x) => x.id === sid);
      return path.length ? getPath(s?.result, path.join(".")) : s?.result;
    }
    return v;
  });
}

let handlers: Record<string, StepHandler> | null = null;
async function getHandlers() {
  handlers ??= (await import("./handlers")).HANDLERS;
  return handlers;
}

/** Testing hook: override handlers. */
export function setHandlers(h: Record<string, StepHandler> | null) {
  handlers = h;
}

function skipDependents(wf: Workflow, failedId: string) {
  let changed = true;
  const dead = new Set([failedId]);
  while (changed) {
    changed = false;
    for (const s of wf.steps) {
      if (!TERMINAL.includes(s.status) && s.deps.some((d) => dead.has(d)) && !dead.has(s.id)) {
        s.status = "skipped";
        s.summary = `Skipped because “${wf.steps.find((x) => x.id === s.deps.find((d) => dead.has(d)))?.title}” did not complete`;
        dead.add(s.id);
        changed = true;
      }
    }
  }
}

function finalStatus(wf: Workflow): WorkflowStatus {
  if (wf.status === "cancelled" || wf.status === "paused") return wf.status;
  if (wf.steps.every((s) => TERMINAL.includes(s.status))) return wf.steps.some((s) => s.status === "failed") ? "failed" : "completed";
  if (wf.steps.some((s) => s.status === "blocked" || s.status === "failed")) return "needs_attention";
  return "running";
}

/** Advances one workflow as far as possible within the time budget. */
export async function advanceWorkflow(ctx: Ctx, id: string, deadline: number): Promise<Workflow | null> {
  const loaded = await getWorkflow(ctx, id);
  if (!loaded || ["paused", "cancelled", "completed", "failed"].includes(loaded.status)) return loaded;
  const wf: Workflow = structuredClone(loaded);
  const save = async () => {
    wf.status = finalStatus(wf);
    if (["completed", "failed"].includes(wf.status) && !wf.finishedAt) wf.finishedAt = ctx.now().toISOString();
    wf.updatedAt = ctx.now().toISOString();
    await ctx.store.put("workflows", wf);
  };
  if (await isSuspended(ctx, wf.workspaceId)) return wf;

  // Wake steps whose approval was decided or whose wait elapsed.
  for (const s of wf.steps) {
    if (s.status === "waiting_approval" && s.approvalId) {
      const a = await ctx.store.get<Approval>("approvals", s.approvalId);
      if (a?.status === "approved") s.status = "pending";
      if (a?.status === "rejected" || a?.status === "expired") {
        s.status = "failed";
        s.error = a.status === "rejected" ? `Rejected by you${a.note ? `: ${a.note}` : ""}` : "Approval expired";
        s.finishedAt = ctx.now().toISOString();
        skipDependents(wf, s.id);
      }
    }
    if (s.status === "waiting" && s.resumeAt && new Date(s.resumeAt) <= ctx.now()) s.status = "pending";
  }

  const hs = await getHandlers();
  for (;;) {
    if (Date.now() > deadline) break;
    const ready = wf.steps.find((s) => s.status === "pending" && s.deps.every((d) => wf.steps.find((x) => x.id === d)?.status === "done"));
    if (!ready) break;
    const handler = hs[ready.type];
    ready.status = "running";
    ready.startedAt ??= ctx.now().toISOString();
    ready.attempts += 1;
    await save();
    const started = Date.now();
    try {
      if (!handler) throw new Error(`No handler for ${ready.type}`);
      const params = resolveParams(ready.params, wf.steps);
      const { value: out, usage } = await withUsageScope(() => handler({ ctx, workflow: wf, step: ready, params }));
      ready.usage = { aiUsd: ready.usage.aiUsd + usage.costUsd, aiCalls: ready.usage.aiCalls + usage.calls, models: [...new Set([...ready.usage.models, ...usage.models])], ms: ready.usage.ms + (Date.now() - started) };
      ready.summary = out.summary;
      ready.error = undefined;
      if (out.status === "done") {
        ready.status = "done";
        ready.result = out.result ?? {};
        ready.finishedAt = ctx.now().toISOString();
      } else if (out.status === "waiting") {
        ready.status = "waiting";
        ready.resumeAt = out.resumeAt.toISOString();
        ready.state = { ...(ready.state ?? {}), ...(out.state ?? {}) };
        ready.attempts = 0;
      } else if (out.status === "needs_approval") {
        ready.status = "waiting_approval";
        ready.approvalId = out.approvalId;
        ready.attempts = 0;
      } else {
        ready.status = "blocked";
        ready.attempts = 0;
      }
    } catch (e) {
      ready.usage.ms += Date.now() - started;
      ready.error = errorMessage(e);
      if (ready.attempts >= MAX_ATTEMPTS) {
        ready.status = "failed";
        ready.finishedAt = ctx.now().toISOString();
        skipDependents(wf, ready.id);
        await logActivity(ctx, { actor: `workflow:${wf.id}`, action: "workflow.step.failed", summary: `${wf.goal} → ${ready.title} failed: ${ready.error}`, level: "error", workspaceId: wf.workspaceId, ref: { kind: "workflow", id: wf.id } });
      } else {
        ready.status = "waiting";
        ready.resumeAt = new Date(ctx.now().getTime() + 30_000 * 2 ** ready.attempts).toISOString();
        ready.summary = `Retrying after error: ${ready.error}`;
      }
    }
    await save();
  }
  const before = loaded.status;
  await save();
  if (before !== wf.status && (wf.status === "completed" || wf.status === "failed"))
    await logActivity(ctx, { actor: `workflow:${wf.id}`, action: `workflow.${wf.status}`, summary: `${wf.status === "completed" ? "Completed" : "Finished with errors"}: ${wf.goal}`, level: wf.status === "completed" ? "success" : "warning", workspaceId: wf.workspaceId, ref: { kind: "workflow", id: wf.id } });
  return wf;
}

/** Runs every active workflow. Safe to call concurrently (lease-protected). */
export async function runWorkflows(ctx: Ctx, budgetMs = 45_000): Promise<{ advanced: number; skipped?: string }> {
  const owner = `runner-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  if (!(await tryLease(ctx.store, "workflow-runner", budgetMs + 30_000, owner))) return { advanced: 0, skipped: "another runner is active" };
  const deadline = Date.now() + budgetMs;
  let advanced = 0;
  try {
    const active = (await ctx.store.list<Workflow>("workflows", { newestFirst: false })).filter((w) => w.status === "running" || w.status === "needs_attention");
    for (const w of active) {
      if (Date.now() > deadline) break;
      await advanceWorkflow(ctx, w.id, deadline);
      advanced++;
    }
  } finally {
    await releaseLease(ctx.store, "workflow-runner", owner);
  }
  return { advanced };
}

// ---------------------------------------------------------------------------
// Owner controls
// ---------------------------------------------------------------------------

export async function controlWorkflow(ctx: Ctx, id: string, action: "pause" | "resume" | "cancel") {
  const wf = await getWorkflow(ctx, id);
  if (!wf) throw new Error("Workflow not found");
  const next: Workflow = structuredClone(wf);
  if (action === "pause" && !["completed", "failed", "cancelled"].includes(wf.status)) next.status = "paused";
  if (action === "resume" && wf.status === "paused") next.status = "running";
  if (action === "cancel") {
    next.status = "cancelled";
    for (const s of next.steps) if (!TERMINAL.includes(s.status)) (s.status = "cancelled"), (s.summary = "Cancelled by you");
    for (const s of wf.steps) if (s.approvalId && s.status === "waiting_approval") {
      const a = await ctx.store.get<Approval>("approvals", s.approvalId);
      if (a?.status === "pending") await ctx.store.put("approvals", { ...a, status: "expired", note: "workflow cancelled" });
    }
  }
  next.updatedAt = ctx.now().toISOString();
  await ctx.store.put("workflows", next);
  await logActivity(ctx, { actor: "owner", action: `workflow.${action}`, summary: `${action[0]!.toUpperCase()}${action.slice(1)}: ${wf.goal}`, ref: { kind: "workflow", id } });
  return next;
}

/** Modify a step that has not run yet, skip it, or retry a failed/blocked one. */
export async function modifyStep(ctx: Ctx, id: string, stepId: string, change: { params?: Record<string, unknown>; skip?: boolean; retry?: boolean }) {
  const wf = await getWorkflow(ctx, id);
  if (!wf) throw new Error("Workflow not found");
  const next: Workflow = structuredClone(wf);
  const s = next.steps.find((x) => x.id === stepId);
  if (!s) throw new Error("Step not found");
  if (change.params) {
    if (!["pending", "blocked", "failed", "waiting"].includes(s.status)) throw new Error("This step already ran or is running.");
    const allowed = STEP_TYPES[s.type]!.params;
    for (const k of Object.keys(change.params)) if (!allowed.includes(k)) throw new Error(`Parameter ${k} is not valid for ${s.type}`);
    s.params = { ...s.params, ...change.params };
  }
  if (change.skip) {
    if (TERMINAL.includes(s.status)) throw new Error("Step already finished");
    s.status = "skipped";
    s.summary = "Skipped by you";
    skipDependents(next, s.id);
  }
  if (change.retry) {
    if (!["failed", "blocked"].includes(s.status)) throw new Error("Only failed or blocked steps can be retried");
    s.status = "pending";
    s.attempts = 0;
    s.error = undefined;
    for (const d of next.steps) if (d.status === "skipped" && d.summary?.startsWith("Skipped because")) (d.status = "pending"), (d.summary = undefined);
    if (next.status !== "paused") next.status = "running";
  }
  next.updatedAt = ctx.now().toISOString();
  await ctx.store.put("workflows", next);
  return next;
}
