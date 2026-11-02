import { createHash } from "node:crypto";
import type { Ctx } from "@/core/context";
import { HttpError, fetchJson } from "@/core/http";

/** Vercel REST integration: projects, file uploads, preview/production deployments, logs, rollback, domains. */
const API = "https://api.vercel.com";

export interface VercelAuth {
  token: string;
  teamId?: string;
  user?: string;
  via: "oauth" | "token";
  /** "Protection Bypass for Automation" secret, so BINGO can verify protected previews. */
  bypassSecret?: string;
}

export async function vercelAuth(ctx: Ctx): Promise<VercelAuth | null> {
  return ctx.vault.getJson<VercelAuth>("global", "vercel");
}

function withTeam(path: string, teamId?: string) {
  if (!teamId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}`;
}

async function vc<T>(ctx: Ctx, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const auth = await vercelAuth(ctx);
  if (!auth) throw new Error("Vercel is not connected. Settings → Connections → Vercel → Authorize.");
  return fetchJson<T>(ctx, `${API}${withTeam(path, auth.teamId)}`, { method: init.method, body: init.body, headers: { authorization: `Bearer ${auth.token}`, ...(init.headers ?? {}) }, timeoutMs: 120_000 });
}

export async function vercelConnectToken(ctx: Ctx, token: string, teamId?: string, via: VercelAuth["via"] = "token", bypassSecret?: string) {
  const me = await fetchJson<{ user: { username: string } }>(ctx, `${API}/v2/user`, { headers: { authorization: `Bearer ${token}` } });
  await ctx.vault.setJson("global", "vercel", { token, teamId: teamId || undefined, user: me.user.username, via, bypassSecret } satisfies VercelAuth, { user: me.user.username });
  return me.user.username;
}

/** Vercel Integration OAuth (marketplace integration "Authorize" flow). */
export async function vercelExchangeCode(ctx: Ctx, code: string) {
  const clientId = process.env.VERCEL_CLIENT_ID;
  const clientSecret = process.env.VERCEL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Set VERCEL_CLIENT_ID / VERCEL_CLIENT_SECRET for the Vercel integration, or paste an access token.");
  const r = await fetchJson<{ access_token: string; team_id?: string | null }>(ctx, `${API}/v2/oauth/access_token`, {
    form: { client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${ctx.env.publicUrl}/api/oauth/vercel/callback` },
  });
  return vercelConnectToken(ctx, r.access_token, r.team_id ?? undefined, "oauth");
}

export interface VercelProject {
  id: string;
  name: string;
}

export async function getProject(ctx: Ctx, idOrName: string): Promise<VercelProject | null> {
  try {
    return await vc<VercelProject>(ctx, `/v9/projects/${encodeURIComponent(idOrName)}`);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

export async function createProject(ctx: Ctx, name: string, opts: { framework?: string; env?: { key: string; value: string; target: string[] }[] } = {}): Promise<VercelProject & { created: boolean }> {
  const existing = await getProject(ctx, name);
  if (existing) return { ...existing, created: false };
  const body = {
    name,
    framework: opts.framework ?? "nextjs",
    environmentVariables: (opts.env ?? []).map((e) => ({ key: e.key, value: e.value, target: e.target, type: "encrypted" })),
  };
  let p: VercelProject;
  try {
    p = await vc<VercelProject>(ctx, "/v11/projects", { body });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) p = await vc<VercelProject>(ctx, "/v10/projects", { body });
    else throw e;
  }
  return { ...p, created: true };
}

export type ReadyState = "QUEUED" | "BUILDING" | "INITIALIZING" | "READY" | "ERROR" | "CANCELED";

export interface VercelDeployment {
  id: string;
  url: string; // without protocol
  readyState: ReadyState;
  target?: "production" | "staging" | null;
  alias?: string[];
  errorMessage?: string;
  inspectorUrl?: string;
  createdAt?: number;
}

export function sha1(buf: Buffer) {
  return createHash("sha1").update(buf).digest("hex");
}

/** Uploads files by content digest (only missing ones are sent) and creates a deployment. */
export async function deployFiles(
  ctx: Ctx,
  opts: { projectName: string; files: { path: string; content: string | Buffer }[]; target: "preview" | "production"; meta?: Record<string, string> },
): Promise<VercelDeployment> {
  const auth = await vercelAuth(ctx);
  if (!auth) throw new Error("Vercel is not connected.");
  const entries = opts.files.map((f) => {
    const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8");
    return { file: f.path, sha: sha1(buf), size: buf.length, buf };
  });
  for (const e of entries) {
    const res = await ctx.fetch(`${API}${withTeam("/v2/files", auth.teamId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/octet-stream", "x-vercel-digest": e.sha, "content-length": String(e.size) },
      body: new Uint8Array(e.buf),
    });
    if (!res.ok && res.status !== 409) throw new HttpError(res.status, `${API}/v2/files`, await res.text());
  }
  return vc<VercelDeployment>(ctx, "/v13/deployments", {
    body: {
      name: opts.projectName,
      project: opts.projectName,
      ...(opts.target === "production" ? { target: "production" } : {}),
      files: entries.map((e) => ({ file: e.file, sha: e.sha, size: e.size })),
      projectSettings: { framework: "nextjs" },
      meta: opts.meta ?? {},
    },
  });
}

export async function getDeployment(ctx: Ctx, id: string): Promise<VercelDeployment> {
  return vc<VercelDeployment>(ctx, `/v13/deployments/${encodeURIComponent(id)}`);
}

export async function deploymentLogs(ctx: Ctx, id: string): Promise<string[]> {
  const ev = await vc<{ type: string; created: number; payload?: { text?: string }; text?: string }[]>(ctx, `/v3/deployments/${encodeURIComponent(id)}/events?builds=1&limit=-1`);
  return (Array.isArray(ev) ? ev : []).map((e) => e.payload?.text ?? e.text ?? "").filter(Boolean);
}

export async function listProductionDeployments(ctx: Ctx, projectId: string): Promise<VercelDeployment[]> {
  const r = await vc<{ deployments: (VercelDeployment & { uid?: string; state?: ReadyState })[] }>(ctx, `/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=20`);
  return r.deployments.map((d) => ({ ...d, id: d.id ?? d.uid!, readyState: d.readyState ?? d.state! }));
}

export async function rollbackTo(ctx: Ctx, projectId: string, deploymentId: string) {
  return vc(ctx, `/v9/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(deploymentId)}`, { method: "POST", body: {} });
}

export async function addDomain(ctx: Ctx, projectId: string, domain: string) {
  return vc<{ name: string; verified: boolean; verification?: { type: string; domain: string; value: string }[] }>(ctx, `/v10/projects/${encodeURIComponent(projectId)}/domains`, { body: { name: domain } });
}

/** Fetches a deployed URL like a visitor would (with the automation bypass for protected previews). */
export async function fetchDeployed(ctx: Ctx, url: string): Promise<{ status: number; html: string }> {
  const auth = await vercelAuth(ctx);
  const res = await ctx.fetch(url, { headers: auth?.bypassSecret ? { "x-vercel-protection-bypass": auth.bypassSecret } : {}, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  return { status: res.status, html: await res.text() };
}
