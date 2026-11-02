import type { Ctx } from "./context";

/** Owner profile + workspace list. Kept small; everything else lives in its own module. */
export interface OwnerSettings {
  id: "owner";
  name: string;
  email: string;
  phone: string;
  timezone: string;
  preferredLanguage: string; // BCP-47
  telegramChatId: string;
  workingHours: { start: string; end: string; days: number[] }; // days: 1=Mon..7=Sun
}

export interface Workspace {
  id: string;
  name: string;
  parentId?: string;
  website?: string;
  /** Name of this company in the ISSHAAN task system's Companies sheet. */
  taskSystemCompany?: string;
  suspended?: boolean;
}

export const DEFAULT_OWNER: OwnerSettings = {
  id: "owner",
  name: "Owner",
  email: "",
  phone: "",
  timezone: "Asia/Kolkata",
  preferredLanguage: "en",
  telegramChatId: "",
  workingHours: { start: "10:00", end: "19:00", days: [1, 2, 3, 4, 5, 6] },
};

export const DEFAULT_WORKSPACES: Workspace[] = [
  { id: "ws_isshaan", name: "ISSHAAN", taskSystemCompany: "ISSHAAN" },
  { id: "ws_carpediem", name: "Carpediem", parentId: "ws_isshaan", taskSystemCompany: "Carpediem" },
];

export async function getOwner(ctx: Ctx): Promise<OwnerSettings> {
  const s = await ctx.store.get<OwnerSettings>("settings", "owner");
  return { ...DEFAULT_OWNER, ...(s ?? {}) };
}

export async function saveOwner(ctx: Ctx, patch: Partial<OwnerSettings>): Promise<OwnerSettings> {
  const cur = await getOwner(ctx);
  const next = { ...cur, ...patch, id: "owner" as const };
  await ctx.store.put("settings", next);
  return next;
}

export async function listWorkspaces(ctx: Ctx): Promise<Workspace[]> {
  const rows = await ctx.store.list<Workspace>("workspaces", { newestFirst: false });
  if (rows.length) return rows;
  for (const w of DEFAULT_WORKSPACES) await ctx.store.put("workspaces", w);
  return DEFAULT_WORKSPACES;
}

export async function getWorkspace(ctx: Ctx, id: string): Promise<Workspace | null> {
  await listWorkspaces(ctx);
  return ctx.store.get<Workspace>("workspaces", id);
}

/** Finds the workspace a request talks about ("Carpediem SleepTime" → Carpediem). */
export async function resolveWorkspace(ctx: Ctx, text: string, fallback = "ws_carpediem"): Promise<Workspace> {
  const all = await listWorkspaces(ctx);
  const lower = text.toLowerCase();
  const hit = all.find((w) => lower.includes(w.name.toLowerCase()));
  return hit ?? all.find((w) => w.id === fallback) ?? all[0]!;
}
