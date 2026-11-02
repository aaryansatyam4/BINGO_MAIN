import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { authorize } from "@/core/policy";
import { errorMessage } from "@/core/util";

/**
 * Client for the company's EXISTING Google-Sheets task system (ISSHAAN Task
 * Management, an Apps Script web app). BINGO does not create a replacement
 * task system: it logs in as a normal staff account and calls the same API the
 * dashboard uses, so the sheet's schema, formulas, reminders and approvals keep
 * working exactly as before.
 *
 * Duplicate protection: every task BINGO creates carries a stable reference
 * tag `[BINGO:<ref>]` in its details. Before creating, BINGO checks its own
 * ref index and the live task list for that tag.
 */
export interface TaskSystemConfig {
  id: "task_system";
  apiUrl: string;
  loginId: string;
  /** Who gets which kind of follow-up. Names must exist in the Staff sheet. */
  routing: Record<string, string>;
  defaultLevel: 1 | 2 | 3;
}

export type TaskKind =
  | "design_approval"
  | "distributor_followup"
  | "documentation_request"
  | "website_testing"
  | "campaign_launch"
  | "interview_prep"
  | "regulatory_verification"
  | "meeting_followup"
  | "general";

export interface TaskRequest {
  ref: string; // stable id, e.g. "meeting:mtg_123:followup"
  kind: TaskKind;
  title: string;
  details: string;
  deadline?: Date;
  level?: 1 | 2 | 3;
  company?: string;
  to?: string;
}

export interface TaskRef {
  id: string; // ref
  taskId: string;
  to: string;
  title: string;
  createdAt: string;
}

export async function getTaskConfig(ctx: Ctx): Promise<TaskSystemConfig | null> {
  return ctx.store.get<TaskSystemConfig>("settings", "task_system");
}

export async function saveTaskConfig(ctx: Ctx, cfg: Omit<TaskSystemConfig, "id">, password?: string) {
  await ctx.store.put("settings", { ...cfg, id: "task_system" });
  if (password) {
    await ctx.vault.set("global", "task_system:password", password);
    await ctx.vault.revoke("global", "task_system:token");
  }
}

async function post<T>(ctx: Ctx, cfg: TaskSystemConfig, body: Record<string, unknown>): Promise<{ ok: boolean; data?: T; error?: string; code?: string }> {
  // Apps Script web apps accept text/plain POSTs (no CORS preflight) and answer JSON.
  const res = await ctx.fetch(cfg.apiUrl, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify(body), redirect: "follow", signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `Task system returned HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
}

async function token(ctx: Ctx, cfg: TaskSystemConfig, fresh = false): Promise<string> {
  if (!fresh) {
    const t = await ctx.vault.get("global", "task_system:token");
    if (t) return t;
  }
  const password = await ctx.vault.get("global", "task_system:password");
  if (!password) throw new Error("Task system password is not set (Settings → Connections → Company task sheet).");
  const r = await post<{ token: string; name: string }>(ctx, cfg, { action: "login", loginId: cfg.loginId, password });
  if (!r.ok || !r.data?.token) throw new Error(`Task system login failed: ${r.error ?? "no token"}`);
  await ctx.vault.set("global", "task_system:token", r.data.token, { name: r.data.name });
  return r.data.token;
}

async function call<T>(ctx: Ctx, cfg: TaskSystemConfig, action: string, params: Record<string, unknown> = {}): Promise<T> {
  let r = await post<T>(ctx, cfg, { action, token: await token(ctx, cfg), ...params });
  if (!r.ok && r.code === "AUTH") r = await post<T>(ctx, cfg, { action, token: await token(ctx, cfg, true), ...params });
  if (!r.ok) throw new Error(r.error ?? `Task system action ${action} failed`);
  return r.data as T;
}

interface DashboardTask {
  id: string;
  title: string;
  details: string;
  to: string;
  status: string;
}

export async function listTaskSystemTasks(ctx: Ctx): Promise<DashboardTask[]> {
  const cfg = await getTaskConfig(ctx);
  if (!cfg) return [];
  const d = await call<{ tasks: DashboardTask[] }>(ctx, cfg, "load");
  return d.tasks ?? [];
}

export const refTag = (ref: string) => `[BINGO:${ref}]`;

export type TaskResult =
  | { status: "created"; taskId: string; to: string; message: string }
  | { status: "exists"; taskId: string; to: string; message: string }
  | { status: "not_configured" | "blocked" | "error"; message: string };

export async function createCompanyTask(ctx: Ctx, req: TaskRequest, requestedBy = "bingo", workspaceId?: string): Promise<TaskResult> {
  const cfg = await getTaskConfig(ctx);
  if (!cfg?.apiUrl) return { status: "not_configured", message: "Company task sheet is not connected (Settings → Connections → Company task sheet)." };

  const known = await ctx.store.get<TaskRef>("task_refs", req.ref);
  if (known) return { status: "exists", taskId: known.taskId, to: known.to, message: `Task already exists: ${known.taskId}` };

  const to = req.to ?? cfg.routing[req.kind] ?? cfg.routing.default;
  const auth = await authorize(ctx, {
    kind: "task.create",
    workspaceId,
    payload: { ref: req.ref, to: to ?? "(self)", title: req.title },
    title: `Create task: ${req.title}`,
    summary: `${req.title} → ${to ?? "BINGO's own task list"}`,
    requestedBy,
  });
  if (!auth.allowed) return { status: auth.blocked ? "blocked" : "blocked", message: auth.reason };

  try {
    // Second line of duplicate defence: look for the tag in the live sheet.
    const live = await listTaskSystemTasks(ctx);
    const dup = live.find((t) => (t.details ?? "").includes(refTag(req.ref)));
    if (dup) {
      await ctx.store.put("task_refs", { id: req.ref, taskId: dup.id, to: dup.to, title: dup.title, createdAt: ctx.now().toISOString() } satisfies TaskRef);
      return { status: "exists", taskId: dup.id, to: dup.to, message: `Task already exists in the sheet: ${dup.id}` };
    }
    const me = await ctx.vault.list().then((l) => l.find((s) => s.id === "global:task_system:token")?.meta?.name);
    const r = await call<{ id: string; message: string }>(ctx, cfg, "createTask", {
      to: to ?? me,
      title: req.title.slice(0, 200),
      details: `${req.details}\n\n${refTag(req.ref)}`,
      level: req.level ?? cfg.defaultLevel ?? 2,
      deadline: req.deadline ? req.deadline.toISOString() : "",
      company: req.company ?? "",
    });
    const assignee = to ?? me ?? "self";
    await ctx.store.put("task_refs", { id: req.ref, taskId: r.id, to: assignee, title: req.title, createdAt: ctx.now().toISOString() } satisfies TaskRef);
    await logActivity(ctx, { actor: requestedBy, action: "task.created", summary: `Task ${r.id} created in the company sheet for ${assignee}: ${req.title}`, level: "success", workspaceId, ref: { kind: "task", id: r.id } });
    return { status: "created", taskId: r.id, to: assignee, message: r.message };
  } catch (e) {
    await logActivity(ctx, { actor: requestedBy, action: "task.error", summary: `Could not create task "${req.title}": ${errorMessage(e)}`, level: "error", workspaceId });
    return { status: "error", message: errorMessage(e) };
  }
}
