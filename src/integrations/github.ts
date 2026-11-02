import type { Ctx } from "@/core/context";
import { HttpError, fetchJson } from "@/core/http";

/**
 * GitHub REST integration for BINGO DEVELOPER.
 * Access is scoped: BINGO writes only to repositories it created or that the
 * owner explicitly added to the allow-list.
 */
const API = "https://api.github.com";

export interface GithubAuth {
  token: string;
  login: string;
  via: "oauth" | "token";
}

export async function githubAuth(ctx: Ctx): Promise<GithubAuth | null> {
  return ctx.vault.getJson<GithubAuth>("global", "github");
}

async function gh<T>(ctx: Ctx, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const auth = await githubAuth(ctx);
  if (!auth) throw new Error("GitHub is not connected. Settings → Connections → GitHub → Authorize.");
  return fetchJson<T>(ctx, `${API}${path}`, {
    method: init.method,
    body: init.body,
    headers: { authorization: `Bearer ${auth.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "bingo-developer" },
  });
}

export async function githubConnectToken(ctx: Ctx, token: string, via: GithubAuth["via"] = "token") {
  const me = await fetchJson<{ login: string }>(ctx, `${API}/user`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "bingo-developer" } });
  await ctx.vault.setJson("global", "github", { token, login: me.login, via } satisfies GithubAuth, { login: me.login });
  return me.login;
}

export async function githubOAuthUrl(ctx: Ctx, state: string) {
  const clientId = process.env.GITHUB_CLIENT_ID ?? (await ctx.vault.get("global", "github:client_id"));
  if (!clientId) throw new Error("Set GITHUB_CLIENT_ID (GitHub OAuth app) or paste a fine-grained token instead.");
  const p = new URLSearchParams({ client_id: clientId, redirect_uri: `${ctx.env.publicUrl}/api/oauth/github/callback`, scope: "repo", state, allow_signup: "false" });
  return `https://github.com/login/oauth/authorize?${p}`;
}

export async function githubExchangeCode(ctx: Ctx, code: string) {
  const clientId = process.env.GITHUB_CLIENT_ID ?? (await ctx.vault.get("global", "github:client_id"));
  const clientSecret = process.env.GITHUB_CLIENT_SECRET ?? (await ctx.vault.get("global", "github:client_secret"));
  if (!clientId || !clientSecret) throw new Error("GitHub OAuth app is not configured.");
  const r = await fetchJson<{ access_token?: string; error_description?: string }>(ctx, "https://github.com/login/oauth/access_token", {
    form: { client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${ctx.env.publicUrl}/api/oauth/github/callback` },
  });
  if (!r.access_token) throw new Error(`GitHub OAuth failed: ${r.error_description ?? "no token"}`);
  return githubConnectToken(ctx, r.access_token, "oauth");
}

// ---------------------------------------------------------------------------
// Scope control
// ---------------------------------------------------------------------------

export interface RepoRecord {
  id: string; // owner/name
  owner: string;
  name: string;
  createdByBingo: boolean;
  defaultBranch: string;
  htmlUrl: string;
  repoId: number;
  addedAt: string;
}

export async function allowedRepo(ctx: Ctx, fullName: string): Promise<RepoRecord | null> {
  return ctx.store.get<RepoRecord>("repos", fullName.toLowerCase());
}

export async function allowRepo(ctx: Ctx, fullName: string): Promise<RepoRecord> {
  const r = await gh<{ id: number; name: string; owner: { login: string }; default_branch: string; html_url: string }>(ctx, `/repos/${fullName}`);
  const rec: RepoRecord = { id: fullName.toLowerCase(), owner: r.owner.login, name: r.name, createdByBingo: false, defaultBranch: r.default_branch, htmlUrl: r.html_url, repoId: r.id, addedAt: ctx.now().toISOString() };
  await ctx.store.put("repos", rec);
  return rec;
}

async function requireAllowed(ctx: Ctx, owner: string, repo: string) {
  const rec = await allowedRepo(ctx, `${owner}/${repo}`);
  if (!rec) throw new Error(`BINGO is not allowed to write to ${owner}/${repo}. Add it under Settings → Connections → GitHub → Allowed repositories.`);
  return rec;
}

// ---------------------------------------------------------------------------
// Repository operations
// ---------------------------------------------------------------------------

export async function createRepo(ctx: Ctx, opts: { name: string; description: string; private: boolean; org?: string }): Promise<RepoRecord> {
  const path = opts.org ? `/orgs/${opts.org}/repos` : "/user/repos";
  let r: { id: number; name: string; owner: { login: string }; default_branch: string; html_url: string };
  try {
    r = await gh(ctx, path, { body: { name: opts.name, description: opts.description, private: opts.private, auto_init: true } });
  } catch (e) {
    if (e instanceof HttpError && e.status === 422) throw new Error(`A repository named "${opts.name}" already exists. BINGO will not overwrite it — choose another name or add it to the allow-list.`);
    throw e;
  }
  const rec: RepoRecord = { id: `${r.owner.login}/${r.name}`.toLowerCase(), owner: r.owner.login, name: r.name, createdByBingo: true, defaultBranch: r.default_branch || "main", htmlUrl: r.html_url, repoId: r.id, addedAt: ctx.now().toISOString() };
  await ctx.store.put("repos", rec);
  return rec;
}

export async function branchSha(ctx: Ctx, owner: string, repo: string, branch: string): Promise<string | null> {
  try {
    const r = await gh<{ object: { sha: string } }>(ctx, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return r.object.sha;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

export async function createBranch(ctx: Ctx, owner: string, repo: string, branch: string, from: string): Promise<string> {
  await requireAllowed(ctx, owner, repo);
  const existing = await branchSha(ctx, owner, repo, branch);
  if (existing) return existing;
  const base = await branchSha(ctx, owner, repo, from);
  if (!base) throw new Error(`Base branch ${from} not found in ${owner}/${repo}`);
  await gh(ctx, `/repos/${owner}/${repo}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: base } });
  return base;
}

/** One commit with many files via the Git Data API (blobs → tree → commit → ref). */
export async function commitFiles(ctx: Ctx, owner: string, repo: string, branch: string, files: { path: string; content: string | Buffer }[], message: string): Promise<{ sha: string; url: string }> {
  const rec = await requireAllowed(ctx, owner, repo);
  if (branch === rec.defaultBranch && !rec.createdByBingo) throw new Error(`BINGO does not commit directly to ${branch} of an existing repository. It works on a branch and opens a pull request.`);
  const head = await branchSha(ctx, owner, repo, branch);
  if (!head) throw new Error(`Branch ${branch} does not exist`);
  const commit = await gh<{ tree: { sha: string } }>(ctx, `/repos/${owner}/${repo}/git/commits/${head}`);
  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const f of files) {
    const content = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8");
    const blob = await gh<{ sha: string }>(ctx, `/repos/${owner}/${repo}/git/blobs`, { body: { content: content.toString("base64"), encoding: "base64" } });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await gh<{ sha: string }>(ctx, `/repos/${owner}/${repo}/git/trees`, { body: { base_tree: commit.tree.sha, tree } });
  const c = await gh<{ sha: string; html_url: string }>(ctx, `/repos/${owner}/${repo}/git/commits`, { body: { message, tree: newTree.sha, parents: [head] } });
  await gh(ctx, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: { sha: c.sha, force: false } });
  return { sha: c.sha, url: c.html_url };
}

export async function openPullRequest(ctx: Ctx, owner: string, repo: string, pr: { title: string; head: string; base: string; body: string }): Promise<{ number: number; url: string }> {
  await requireAllowed(ctx, owner, repo);
  const open = await gh<{ number: number; html_url: string }[]>(ctx, `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${pr.head}`)}`);
  if (open[0]) return { number: open[0].number, url: open[0].html_url };
  const r = await gh<{ number: number; html_url: string }>(ctx, `/repos/${owner}/${repo}/pulls`, { body: pr });
  return { number: r.number, url: r.html_url };
}

export async function checkRuns(ctx: Ctx, owner: string, repo: string, ref: string) {
  const r = await gh<{ check_runs: { name: string; status: string; conclusion: string | null; html_url: string }[] }>(ctx, `/repos/${owner}/${repo}/commits/${ref}/check-runs`);
  return r.check_runs;
}

export async function readRepoFile(ctx: Ctx, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const r = await gh<{ content: string; encoding: string }>(ctx, `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    return Buffer.from(r.content, "base64").toString("utf8");
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

export async function listRepoTree(ctx: Ctx, owner: string, repo: string, ref: string): Promise<string[]> {
  const r = await gh<{ tree: { path: string; type: string }[] }>(ctx, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  return r.tree.filter((t) => t.type === "blob").map((t) => t.path);
}
