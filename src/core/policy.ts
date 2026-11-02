import type { Ctx } from "./context";
import { logActivity } from "./context";
import { hashPayload, newId } from "./util";

/**
 * Deterministic permission & approval engine.
 *
 * Every external side effect goes through `authorize()` right before it is
 * executed. AI planning can propose actions, but it cannot skip this check:
 * the decision depends only on stored policy, kill switches, limits and
 * owner approvals that are bound to a hash of the exact payload.
 */
export type ActionKind =
  | "email.send.initial" // first contact with an external person
  | "email.send.reply" // reply in an existing thread
  | "email.send.owner" // email to the owner's own inbox (reports, previews)
  | "calendar.event.create"
  | "deploy.preview"
  | "deploy.production"
  | "deploy.rollback"
  | "domain.change"
  | "repo.create"
  | "repo.commit"
  | "phone.call.owner"
  | "phone.call.external"
  | "telegram.notify.owner"
  | "sheet.write"
  | "task.create"
  | "creative.publish"
  | "skill.activate"
  | "ai.spend";

export type Mode = "auto" | "approval" | "forbidden";

export interface PolicyConfig {
  id: string; // "policy:<workspaceId|global>"
  modes: Partial<Record<ActionKind, Mode>>;
  limits: {
    previewDeploysPerDay: number;
    initialEmailsPerDay: number;
    initialEmailsPerDomainPerDay: number;
    minSecondsBetweenEmails: number;
    callsPerDay: number;
  };
}

export const DEFAULT_MODES: Record<ActionKind, Mode> = {
  "email.send.initial": "approval",
  "email.send.reply": "approval",
  "email.send.owner": "auto",
  "calendar.event.create": "approval",
  "deploy.preview": "auto",
  "deploy.production": "approval",
  "deploy.rollback": "approval",
  "domain.change": "approval",
  "repo.create": "auto",
  "repo.commit": "auto",
  "phone.call.owner": "auto", // still gated by the escalation policy
  "phone.call.external": "approval",
  "telegram.notify.owner": "auto",
  "sheet.write": "auto",
  "task.create": "auto",
  "creative.publish": "approval",
  "skill.activate": "approval",
  "ai.spend": "auto",
};

/** These can never be switched to "auto": the spec requires a human for each one. */
export const ALWAYS_HUMAN: ActionKind[] = ["deploy.production", "domain.change", "phone.call.external", "skill.activate"];

export const DEFAULT_LIMITS: PolicyConfig["limits"] = {
  previewDeploysPerDay: 20,
  initialEmailsPerDay: 40,
  initialEmailsPerDomainPerDay: 2,
  minSecondsBetweenEmails: 20,
  callsPerDay: 6,
};

export async function getPolicy(ctx: Ctx, workspaceId?: string): Promise<PolicyConfig> {
  const global = await ctx.store.get<PolicyConfig>("policies", "policy:global");
  const ws = workspaceId ? await ctx.store.get<PolicyConfig>("policies", `policy:${workspaceId}`) : null;
  return {
    id: `policy:${workspaceId ?? "global"}`,
    modes: { ...DEFAULT_MODES, ...(global?.modes ?? {}), ...(ws?.modes ?? {}) },
    limits: { ...DEFAULT_LIMITS, ...(global?.limits ?? {}), ...(ws?.limits ?? {}) },
  };
}

export async function savePolicy(ctx: Ctx, scope: string, patch: Partial<Pick<PolicyConfig, "modes" | "limits">>) {
  const id = `policy:${scope}`;
  const cur = (await ctx.store.get<PolicyConfig>("policies", id)) ?? { id, modes: {}, limits: { ...DEFAULT_LIMITS } };
  const modes = { ...cur.modes, ...(patch.modes ?? {}) };
  for (const k of ALWAYS_HUMAN) if (modes[k] === "auto") modes[k] = "approval";
  await ctx.store.put("policies", { ...cur, modes, limits: { ...cur.limits, ...(patch.limits ?? {}) } });
}

// ---------------------------------------------------------------------------
// Emergency stop
// ---------------------------------------------------------------------------

export interface KillSwitch {
  id: string; // "kill:global" | "kill:<workspaceId>"
  active: boolean;
  reason: string;
  at: string;
}

export async function setKillSwitch(ctx: Ctx, scope: string, active: boolean, reason = "") {
  await ctx.store.put("killswitch", { id: `kill:${scope}`, active, reason, at: ctx.now().toISOString() } satisfies KillSwitch);
  await logActivity(ctx, {
    actor: "owner",
    action: active ? "automation.suspended" : "automation.resumed",
    summary: active ? `Emergency stop activated (${scope})${reason ? `: ${reason}` : ""}` : `Automations resumed (${scope})`,
    level: active ? "warning" : "success",
  });
}

export async function isSuspended(ctx: Ctx, workspaceId?: string): Promise<KillSwitch | null> {
  const g = await ctx.store.get<KillSwitch>("killswitch", "kill:global");
  if (g?.active) return g;
  if (workspaceId) {
    const w = await ctx.store.get<KillSwitch>("killswitch", `kill:${workspaceId}`);
    if (w?.active) return w;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed" | "expired";

export interface Approval {
  id: string;
  kind: ActionKind;
  workspaceId?: string;
  title: string;
  /** Human-readable explanation of what will happen. */
  summary: string;
  /** Exactly what will be executed. The hash binds the approval to it. */
  payload: unknown;
  payloadHash: string;
  status: ApprovalStatus;
  requestedBy: string;
  requestedAt: string;
  decidedAt?: string;
  decidedVia?: string;
  note?: string;
  workflowId?: string;
  stepId?: string;
  expiresAt?: string;
}

/** A narrowly scoped, previously approved policy, e.g. "publish updates to project X for 30 days". */
export interface StandingApproval {
  id: string;
  kind: ActionKind;
  workspaceId?: string;
  /** Every key here must equal the same key of the action's payload. */
  match: Record<string, string | number | boolean>;
  maxUses?: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
  description: string;
  revoked?: boolean;
}

export async function requestApproval(
  ctx: Ctx,
  a: Pick<Approval, "kind" | "title" | "summary" | "payload" | "requestedBy"> & Partial<Pick<Approval, "workspaceId" | "workflowId" | "stepId" | "expiresAt">>,
): Promise<Approval> {
  const payloadHash = hashPayload(a.payload);
  // Re-use an identical pending request instead of spamming the owner.
  const pending = await ctx.store.list<Approval>("approvals", { where: { status: "pending", payloadHash } });
  if (pending[0]) return pending[0];
  const rec: Approval = {
    id: newId("apr"),
    status: "pending",
    requestedAt: ctx.now().toISOString(),
    payloadHash,
    ...a,
  };
  await ctx.store.put("approvals", rec);
  await logActivity(ctx, {
    actor: a.requestedBy,
    action: "approval.requested",
    summary: `Approval needed: ${a.title}`,
    level: "approval",
    workspaceId: a.workspaceId,
    ref: { kind: "approval", id: rec.id },
  });
  return rec;
}

export async function decideApproval(ctx: Ctx, id: string, decision: "approved" | "rejected", via: string, note?: string): Promise<Approval> {
  const cur = await ctx.store.get<Approval>("approvals", id);
  if (!cur) throw new Error(`Approval ${id} not found`);
  if (cur.status !== "pending") throw new Error(`Approval ${id} is already ${cur.status}`);
  if (cur.expiresAt && new Date(cur.expiresAt) < ctx.now()) {
    await ctx.store.put("approvals", { ...cur, status: "expired" }, { expectVersion: cur._v });
    throw new Error(`Approval ${id} has expired`);
  }
  const next: Approval = { ...cur, status: decision, decidedAt: ctx.now().toISOString(), decidedVia: via, note };
  await ctx.store.put("approvals", next, { expectVersion: cur._v });
  await logActivity(ctx, {
    actor: "owner",
    action: `approval.${decision}`,
    summary: `${decision === "approved" ? "Approved" : "Rejected"}: ${cur.title}`,
    level: decision === "approved" ? "success" : "warning",
    workspaceId: cur.workspaceId,
    ref: { kind: "approval", id },
  });
  return next;
}

export async function listApprovals(ctx: Ctx, status: ApprovalStatus = "pending") {
  return ctx.store.list<Approval>("approvals", { where: { status } });
}

export async function createStandingApproval(ctx: Ctx, s: Omit<StandingApproval, "id" | "uses" | "createdAt">) {
  if (s.kind === "domain.change" || s.kind === "phone.call.external") throw new Error(`${s.kind} cannot have a standing approval.`);
  if (!Object.keys(s.match).length) throw new Error("A standing approval must be narrowly scoped (at least one match field).");
  const rec: StandingApproval = { ...s, id: newId("std"), uses: 0, createdAt: ctx.now().toISOString() };
  await ctx.store.put("standing_approvals", rec);
  return rec;
}

// ---------------------------------------------------------------------------
// authorize(): the single gate before every external action
// ---------------------------------------------------------------------------

export type AuthDecision =
  | { allowed: true; via: "auto" | "approval" | "standing"; approvalId?: string }
  | { allowed: false; reason: string; approval?: Approval; blocked?: boolean };

export interface AuthorizeInput {
  kind: ActionKind;
  workspaceId?: string;
  payload: unknown;
  title: string;
  summary: string;
  requestedBy: string;
  /** An approval the caller believes covers this payload. */
  approvalId?: string;
  workflowId?: string;
  stepId?: string;
}

export async function authorize(ctx: Ctx, input: AuthorizeInput): Promise<AuthDecision> {
  const kill = await isSuspended(ctx, input.workspaceId);
  if (kill) return { allowed: false, blocked: true, reason: `Automations are suspended: ${kill.reason || "emergency stop"}` };

  const policy = await getPolicy(ctx, input.workspaceId);
  let mode = policy.modes[input.kind] ?? "approval";
  if (ALWAYS_HUMAN.includes(input.kind) && mode === "auto") mode = "approval";
  if (mode === "forbidden") return { allowed: false, blocked: true, reason: `Policy forbids ${input.kind}.` };

  const hash = hashPayload(input.payload);

  // An explicit approval must match the exact payload and is single-use.
  if (input.approvalId) {
    const a = await ctx.store.get<Approval>("approvals", input.approvalId);
    if (a && a.status === "approved" && a.payloadHash === hash && a.kind === input.kind) {
      await ctx.store.put("approvals", { ...a, status: "consumed" }, { expectVersion: a._v });
      return { allowed: true, via: "approval", approvalId: a.id };
    }
    if (a && a.status === "rejected") return { allowed: false, blocked: true, reason: `Rejected by owner${a.note ? `: ${a.note}` : ""}.`, approval: a };
    if (a && a.status === "pending" && a.payloadHash === hash) return { allowed: false, reason: "Waiting for approval.", approval: a };
    // Approval for a different payload (content changed after approval) → ask again.
  }

  if (mode === "auto") return { allowed: true, via: "auto" };

  // Standing approvals (narrow, time-boxed).
  const standing = await ctx.store.list<StandingApproval>("standing_approvals", { where: { kind: input.kind } });
  const payload = (input.payload ?? {}) as Record<string, unknown>;
  for (const s of standing) {
    if (s.revoked || new Date(s.expiresAt) < ctx.now()) continue;
    if (s.workspaceId && s.workspaceId !== input.workspaceId) continue;
    if (s.maxUses !== undefined && s.uses >= s.maxUses) continue;
    if (!Object.entries(s.match).every(([k, v]) => payload[k] === v)) continue;
    await ctx.store.put("standing_approvals", { ...s, uses: s.uses + 1 }, { expectVersion: s._v });
    return { allowed: true, via: "standing" };
  }

  const approval = await requestApproval(ctx, {
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    payload: input.payload,
    requestedBy: input.requestedBy,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    stepId: input.stepId,
  });
  return { allowed: false, reason: "Waiting for approval.", approval };
}

/** Counts how many times an action kind happened today (from the action ledger). */
export async function countToday(ctx: Ctx, kind: string, filter?: (d: Record<string, unknown>) => boolean): Promise<number> {
  const day = ctx.now().toISOString().slice(0, 10);
  const rows = await ctx.store.list<{ id: string; kind: string; day: string } & Record<string, unknown>>("action_ledger", { where: { kind, day } });
  return filter ? rows.filter(filter).length : rows.length;
}

export async function recordAction(ctx: Ctx, kind: string, data: Record<string, unknown>) {
  const at = ctx.now();
  await ctx.store.put("action_ledger", { id: newId("led"), kind, day: at.toISOString().slice(0, 10), at: at.toISOString(), ...data });
}
