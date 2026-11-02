import type { Store } from "./store";
import { createStoreFromEnv } from "./store";
import { Vault } from "./vault";
import { newId } from "./util";

/**
 * The service container passed to every module. Tests build one with a
 * MemoryStore and a fake `fetch`; production builds one from the environment.
 */
export interface Ctx {
  store: Store;
  vault: Vault;
  fetch: typeof fetch;
  now: () => Date;
  env: BingoEnv;
}

export interface BingoEnv {
  publicUrl: string;
  cronSecret?: string;
  /** Allows the local child-process sandbox (development only — never in production). */
  allowLocalSandbox: boolean;
  isProduction: boolean;
}

export function envFrom(e: NodeJS.ProcessEnv = process.env): BingoEnv {
  return {
    publicUrl: (e.BINGO_PUBLIC_URL || (e.VERCEL_PROJECT_PRODUCTION_URL ? `https://${e.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000")).replace(/\/$/, ""),
    cronSecret: e.CRON_SECRET,
    allowLocalSandbox: e.BINGO_ALLOW_LOCAL_SANDBOX === "1" && e.NODE_ENV !== "production",
    isProduction: e.NODE_ENV === "production",
  };
}

let cached: Ctx | null = null;

export function getCtx(): Ctx {
  if (cached) return cached;
  const store = createStoreFromEnv();
  const master = process.env.BINGO_MASTER_KEY || (process.env.NODE_ENV !== "production" ? "dev-only-master-key-change-me-0000" : "");
  cached = { store, vault: new Vault(store, master), fetch: globalThis.fetch.bind(globalThis), now: () => new Date(), env: envFrom() };
  return cached;
}

export function makeCtx(parts: Partial<Ctx> & { store: Store }): Ctx {
  return {
    store: parts.store,
    vault: parts.vault ?? new Vault(parts.store, "test-master-key-0123456789abcdef"),
    fetch: parts.fetch ?? globalThis.fetch.bind(globalThis),
    now: parts.now ?? (() => new Date()),
    env: parts.env ?? { publicUrl: "http://localhost:3000", allowLocalSandbox: false, isProduction: false },
  };
}

// ---------------------------------------------------------------------------
// Activity log (append-only, shown on the dashboard and used for audits)
// ---------------------------------------------------------------------------

export type ActivityLevel = "info" | "success" | "warning" | "error" | "approval";

export interface Activity {
  id: string;
  at: string;
  actor: string; // "owner", "bingo", "workflow:<id>", "webhook:twilio"…
  action: string;
  summary: string;
  level: ActivityLevel;
  workspaceId?: string;
  ref?: { kind: string; id: string };
  data?: Record<string, unknown>;
}

export async function logActivity(ctx: Ctx, a: Omit<Activity, "id" | "at" | "level"> & { level?: ActivityLevel }): Promise<Activity> {
  const rec: Activity = { id: newId("act"), at: ctx.now().toISOString(), level: a.level ?? "info", ...a };
  await ctx.store.put("activity", rec);
  return rec;
}

export async function recentActivity(ctx: Ctx, limit = 50): Promise<Activity[]> {
  return ctx.store.list<Activity>("activity", { limit });
}
