import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { authorize, countToday, getPolicy, recordAction } from "@/core/policy";
import { getOwner } from "@/core/settings";
import { errorMessage, newId, sha256, slugify } from "@/core/util";
import { callJson, callToolLoop, extractJson, route } from "@/ai/engine";
import { checkCompliance, type ComplianceResult } from "@/studio/claims";
import { brandContext, brandKitForWorkspace, getAsset, type BrandKit, type Product } from "@/studio/brand";
import { translateText } from "@/lang/translate";
import { pushToSheet } from "@/integrations/sheets-sync";
import * as gh from "@/integrations/github";
import * as vercel from "@/integrations/vercel";
import { DEFAULT_FIELDS, LandingContentSchema, generateLandingProject, type GeneratedFile, type LandingContent, type SiteKind, type SiteSpec } from "./landing";
import { createSandbox, runQualityGate, type Sandbox } from "./sandbox";
import { scanProject, type ScanFinding } from "./scan";

/**
 * BINGO DEVELOPER — turns a request into a real, tested, deployed website.
 * Each function is one durable workflow step; state lives on the BuildProject.
 */

export interface CheckRun {
  revision: number;
  at: string;
  sandbox: string;
  ok: boolean;
  steps: { name: string; ok: boolean; output: string; durationMs: number }[];
  scan: ScanFinding[];
}

export interface DeploymentRec {
  id: string;
  target: "preview" | "production";
  url: string;
  state: vercel.ReadyState;
  revision: number;
  filesDigest: string;
  createdAt: string;
  verified?: { ok: boolean; status: number; detail: string; at: string };
  logsTail?: string[];
  approvalId?: string;
}

export interface BuildProject {
  id: string;
  workspaceId: string;
  request: string;
  kind: SiteKind;
  name: string;
  slug: string;
  productId: string | null;
  spec: SiteSpec;
  content: Record<string, LandingContent>;
  translationReview: { locale: string; reasons: string[] }[];
  compliance: ComplianceResult | null;
  revision: number;
  filesDigest: string;
  checks: CheckRun[];
  repairs: { revision: number; summary: string; at: string }[];
  repo?: { owner: string; name: string; branch: string; prUrl?: string; commitSha?: string; htmlUrl: string };
  vercelProject?: { id: string; name: string; createdByBingo: boolean };
  deployments: DeploymentRec[];
  liveUrl?: string;
  status: "draft" | "content_ready" | "built" | "checks_failed" | "preview_ready" | "awaiting_production_approval" | "live" | "failed";
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

const FILES = "project_files";

export async function getProject(ctx: Ctx, id: string) {
  return ctx.store.get<BuildProject>("build_projects", id);
}
export async function listProjects(ctx: Ctx) {
  return ctx.store.list<BuildProject>("build_projects");
}
async function save(ctx: Ctx, p: BuildProject) {
  await ctx.store.put("build_projects", { ...p, updatedAt: ctx.now().toISOString() });
  return p;
}

export async function getFiles(ctx: Ctx, projectId: string, revision: number): Promise<GeneratedFile[]> {
  const rec = await ctx.store.get<{ id: string; files: { path: string; text?: string; b64?: string }[] }>(FILES, `${projectId}:${revision}`);
  return (rec?.files ?? []).map((f) => ({ path: f.path, content: f.b64 !== undefined ? Buffer.from(f.b64, "base64") : f.text! }));
}

async function putFiles(ctx: Ctx, projectId: string, revision: number, files: GeneratedFile[]) {
  await ctx.store.put(FILES, {
    id: `${projectId}:${revision}`,
    files: files.map((f) => (Buffer.isBuffer(f.content) ? { path: f.path, b64: f.content.toString("base64") } : { path: f.path, text: f.content })),
  });
  return digestFiles(files);
}

export function digestFiles(files: GeneratedFile[]) {
  return sha256(
    files
      .map((f) => `${f.path}:${sha256(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content))}`)
      .sort()
      .join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 1. Understand the request → project spec
// ---------------------------------------------------------------------------

export function inferKind(text: string): SiteKind {
  const t = text.toLowerCase();
  if (/distributor|dealer|partner|дистриб/.test(t)) return "distributor";
  if (/hiring|career|job|recruit/.test(t)) return "hiring";
  if (/event|webinar|registration|conference/.test(t)) return "event";
  if (/corporate wellness|employee/.test(t)) return "corporate-wellness";
  if (/launch/.test(t)) return "launch";
  if (/campaign/.test(t)) return "campaign";
  if (/expansion|export|international/.test(t)) return "expansion";
  if (/lead/.test(t)) return "lead-generation";
  return "product";
}

export function inferLocales(text: string, fallback: string): string[] {
  const t = text.toLowerCase();
  const map: [RegExp, string][] = [
    [/russian|русск|russia|россия/, "ru"],
    [/uzbek/, "uz"],
    [/tajik/, "tg"],
    [/kyrgyz/, "ky"],
    [/turkmen/, "tk"],
    [/khmer|cambodia/, "km"],
    [/\blao\b|laos/, "lo"],
    [/arabic|saudi|uae|emirates/, "ar"],
    [/french|france/, "fr"],
    [/spanish|spain|latam/, "es"],
    [/german|germany/, "de"],
    [/portuguese|brazil/, "pt"],
    [/chinese|mandarin|china/, "zh"],
    [/japanese|japan/, "ja"],
    [/korean|korea/, "ko"],
    [/nepali|nepal/, "ne"],
    [/bengali|bangla/, "bn"],
    [/urdu|pakistan/, "ur"],
    [/tamil/, "ta"],
    [/telugu/, "te"],
    [/hindi/, "hi"],
  ];
  const found = map.filter(([re]) => re.test(t)).map(([, l]) => l);
  const multilingual = /multilingual|multi-language|all languages/.test(t);
  const locales = [...new Set(found)];
  if (multilingual && !locales.includes("en")) locales.push("en");
  if (/english/.test(t) && !locales.includes("en")) locales.push("en");
  return locales.length ? locales : [fallback];
}

const SECTIONS: Record<SiteKind, SiteSpec["sections"]> = {
  product: ["hero", "benefits", "story", "comparison", "evidence", "faq", "form"],
  campaign: ["hero", "benefits", "faq", "form"],
  launch: ["hero", "benefits", "story", "evidence", "faq", "form"],
  distributor: ["hero", "benefits", "story", "faq", "form"],
  "corporate-wellness": ["hero", "benefits", "story", "faq", "form"],
  hiring: ["hero", "benefits", "story", "faq", "form"],
  event: ["hero", "benefits", "faq", "form"],
  "lead-generation": ["hero", "benefits", "faq", "form"],
  expansion: ["hero", "benefits", "story", "faq", "form"],
};

export async function planProject(ctx: Ctx, input: { request: string; workspaceId: string; kind?: SiteKind; locales?: string[]; productId?: string | null }): Promise<BuildProject> {
  const kit = await brandKitForWorkspace(ctx, input.workspaceId);
  if (!kit) throw new Error("This workspace has no brand kit yet (Studio → Brand kits).");
  const product = input.productId ? (kit.products.find((p) => p.id === input.productId) ?? null) : findProductIn(kit, input.request);
  const kind = input.kind ?? inferKind(input.request);
  const owner = await getOwner(ctx);
  const locales = input.locales ?? inferLocales(input.request, owner.preferredLanguage || "en");
  const name = `${product ? product.name : kit.name} — ${kind === "product" ? "landing page" : kind.replace("-", " ")}`;
  const slug = slugify(`${kit.name}-${product?.name ?? ""}-${kind}`);
  const spec: SiteSpec = {
    kind,
    name,
    slug,
    brandName: kit.name,
    colors: kit.colors,
    fonts: kit.fonts,
    locales,
    sections: SECTIONS[kind],
    contactEmail: owner.email,
    leadSource: `site:${slug}`,
  };
  const p: BuildProject = {
    id: newId("prj"),
    workspaceId: input.workspaceId,
    request: input.request,
    kind,
    name,
    slug,
    productId: product?.id ?? null,
    spec,
    content: {},
    translationReview: [],
    compliance: null,
    revision: 0,
    filesDigest: "",
    checks: [],
    repairs: [],
    deployments: [],
    status: "draft",
    notes: [],
    createdAt: ctx.now().toISOString(),
    updatedAt: ctx.now().toISOString(),
  };
  if (!kit.verified) p.notes.push("Brand kit not verified yet — colours/fonts are a draft.");
  if (product && !product.approvedClaims.length) p.notes.push(`${product.name} has no approved claims, so the page will not state product benefits.`);
  await save(ctx, p);
  await logActivity(ctx, { actor: "bingo", action: "build.planned", summary: `Planned ${name} (${locales.join(", ")})`, workspaceId: input.workspaceId, ref: { kind: "project", id: p.id } });
  return p;
}

function findProductIn(kit: BrandKit, text: string): Product | null {
  const t = text.toLowerCase();
  return kit.products.find((p) => t.includes(p.name.toLowerCase())) ?? null;
}

// ---------------------------------------------------------------------------
// 2. Copy (approved claims only) + translation
// ---------------------------------------------------------------------------

export async function writeContent(ctx: Ctx, projectId: string, opts: { market?: string } = {}): Promise<BuildProject> {
  const p = (await getProject(ctx, projectId))!;
  const kit = (await brandKitForWorkspace(ctx, p.workspaceId))!;
  const product = p.productId ? (kit.products.find((x) => x.id === p.productId) ?? null) : null;
  const primary = p.spec.locales[0]!;
  const fields = DEFAULT_FIELDS[p.kind];
  const { data } = await callJson(
    ctx,
    {
      capability: "copywriting",
      system: `You are BINGO's senior conversion copywriter and web strategist. Write premium, specific, honest copy. Follow the brand context exactly; anything not supported by it must be left out rather than invented.\n\n${brandContext(kit, product, opts.market)}`,
      prompt: [
        `Project: ${p.request}`,
        `Page type: ${p.kind}. Sections: ${p.spec.sections.join(", ")}.`,
        `Write in language: ${primary}.`,
        "benefits: 3 items; claimId must be the approved claim id used, or empty string when the item is not a product claim (e.g. service, partnership terms that are approved company facts, or neutral statements).",
        "comparison/evidence: leave rows/items empty unless the brand context contains approved facts for them.",
        p.kind === "distributor"
          ? "This page recruits distributors: explain the company and the opportunity using approved company facts only. Never promise exclusivity, margins, prices, registrations or approvals."
          : "",
        `form.fields: use exactly these fields (translate labels): ${JSON.stringify(fields)}`,
        "privacy.body: a short, plain privacy notice explaining the form data is used only to respond and can be deleted on request.",
        "seo.title ≤ 60 chars, seo.description 120–160 chars.",
      ]
        .filter(Boolean)
        .join("\n"),
      effort: "high",
    },
    LandingContentSchema,
    { purpose: "build.copy", workspaceId: p.workspaceId },
  );
  data.form.fields = data.form.fields.length ? data.form.fields : fields;
  const content: Record<string, LandingContent> = { [primary]: data };
  const review: { locale: string; reasons: string[] }[] = [];
  const glossary = { keep: [kit.name, ...kit.products.map((x) => x.name)] };
  for (const loc of p.spec.locales.slice(1)) {
    const { content: translated, reasons } = await translateContent(ctx, data, primary, loc, glossary, p.workspaceId);
    content[loc] = translated;
    if (reasons.length) review.push({ locale: loc, reasons });
  }
  const allCopy = Object.values(content)
    .map((c) => [c.hero.headline, c.hero.subline, ...c.benefits.map((b) => `${b.title}. ${b.body}`), c.story.body, ...c.faq.map((f) => f.a)].join("\n"))
    .join("\n");
  const compliance = checkCompliance(Object.values(content)[0] ? [content[primary]!.hero.headline, content[primary]!.hero.subline, ...content[primary]!.benefits.map((b) => `${b.title}. ${b.body}`), content[primary]!.story.body, ...content[primary]!.faq.map((f) => f.a)].join("\n") : allCopy, kit, product, { market: opts.market });
  const next: BuildProject = { ...p, content, translationReview: review, compliance, status: "content_ready" };
  if (compliance.status === "blocked") next.notes.push("Copy has blocking compliance issues; the page will not be published until they are fixed.");
  await save(ctx, next);
  return next;
}

/** Translates every string in the content with name/number protection. */
async function translateContent(ctx: Ctx, c: LandingContent, from: string, to: string, glossary: { keep: string[] }, workspaceId: string) {
  const reasons: string[] = [];
  const clone = structuredClone(c);
  const jobs: { get: () => string; set: (v: string) => void }[] = [];
  const visit = (obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      if (["claimId", "name", "type", "required"].includes(k)) continue;
      if (typeof v === "string" && v.trim()) jobs.push({ get: () => obj[k] as string, set: (x) => (obj[k] = x) });
      else if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "string" ? item && jobs.push({ get: () => v[i] as string, set: (x) => (v[i] = x) }) : item && typeof item === "object" && visit(item as Record<string, unknown>)));
      else if (v && typeof v === "object") visit(v as Record<string, unknown>);
    }
  };
  visit(clone as unknown as Record<string, unknown>);
  for (const job of jobs) {
    const r = await translateText(ctx, job.get(), to, { source: from, glossary, workspaceId, purpose: "build.translate" });
    job.set(r.translated);
    for (const reason of r.reviewReasons) if (!reasons.includes(reason)) reasons.push(reason);
  }
  return { content: clone, reasons };
}

// ---------------------------------------------------------------------------
// 3. Generate files (+ approved images) and scan
// ---------------------------------------------------------------------------

export async function generateFiles(ctx: Ctx, projectId: string): Promise<BuildProject> {
  const p = (await getProject(ctx, projectId))!;
  if (!Object.keys(p.content).length) throw new Error("Write the content first.");
  const kit = (await brandKitForWorkspace(ctx, p.workspaceId))!;
  const product = p.productId ? kit.products.find((x) => x.id === p.productId) : null;
  const binary: { path: string; data: Buffer }[] = [];
  const spec = { ...p.spec };
  const packshot = product?.packshotAssetIds[0] ? await getAsset(ctx, product.packshotAssetIds[0]) : null;
  if (packshot) {
    const ext = packshot.mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    binary.push({ path: `public/product.${ext}`, data: Buffer.from(packshot.b64, "base64") });
    spec.productImage = { path: `/product.${ext}`, alt: `${product!.name} by ${kit.name}` };
  }
  const files = generateLandingProject(spec, p.content, binary);
  const revision = p.revision + 1;
  const digest = await putFiles(ctx, p.id, revision, files);
  const next: BuildProject = { ...p, spec, revision, filesDigest: digest, status: "built" };
  await save(ctx, next);
  return next;
}

// ---------------------------------------------------------------------------
// 4. Checks in the sandbox, with AI repair
// ---------------------------------------------------------------------------

export async function runChecks(ctx: Ctx, projectId: string, opts: { repairAttempts?: number } = {}): Promise<BuildProject> {
  let p: BuildProject = (await getProject(ctx, projectId))!;
  let attempts = opts.repairAttempts ?? 2;
  for (;;) {
    const files = await getFiles(ctx, p.id, p.revision);
    const scan = scanProject(files);
    const blocked = scan.filter((f) => f.severity === "block");
    let gate: Awaited<ReturnType<typeof runQualityGate>> = { ok: false, steps: [] };
    let sandboxKind = "none";
    if (!blocked.length) {
      const sbx = await createSandbox(ctx);
      sandboxKind = sbx.kind;
      try {
        await sbx.writeFiles(files);
        gate = await runQualityGate(sbx);
      } finally {
        await sbx.stop();
      }
    }
    const run: CheckRun = { revision: p.revision, at: ctx.now().toISOString(), sandbox: sandboxKind, ok: !blocked.length && gate.ok, steps: gate.steps, scan };
    p = { ...p, checks: [...p.checks, run], status: run.ok ? "built" : "checks_failed" };
    await save(ctx, p);
    await logActivity(ctx, {
      actor: "bingo",
      action: run.ok ? "build.checks.passed" : "build.checks.failed",
      summary: run.ok ? `${p.name} r${p.revision}: install, typecheck, build and tests passed (${sandboxKind} sandbox)` : `${p.name} r${p.revision}: ${blocked.length ? `security scan blocked (${blocked[0]!.detail})` : `${gate.steps.at(-1)?.name} failed`}`,
      level: run.ok ? "success" : "warning",
      workspaceId: p.workspaceId,
      ref: { kind: "project", id: p.id },
    });
    if (run.ok || attempts-- <= 0 || blocked.length) return p;
    const repaired = await repairWithAgent(ctx, p, run);
    if (!repaired) return p;
    p = repaired;
  }
}

/** Coding agent: reads the failure, edits files in memory, re-checks in the sandbox. */
export async function repairWithAgent(ctx: Ctx, p: BuildProject, failed: CheckRun): Promise<BuildProject | null> {
  if (!(await route(ctx, "coding", { workspaceId: p.workspaceId, needsMethod: "toolLoop" })).length) {
    p.notes.push("Automatic repair needs a coding-capable model with tool use (e.g. Claude). Connect it in Settings → AI Models.");
    await save(ctx, p);
    return null;
  }
  const files = await getFiles(ctx, p.id, p.revision);
  const map = new Map(files.map((f) => [f.path, f]));
  let sbx: Sandbox | null = null;
  const failure = failed.steps.find((s) => !s.ok);
  const res = await callToolLoop(
    ctx,
    "coding",
    {
      system:
        "You are BINGO DEVELOPER, an expert Next.js + TypeScript engineer. Fix the failing check with the smallest correct change. Do not add dependencies. Do not read or print environment variables or secrets. Do not change approved copy in content/copy.ts unless the failure is caused by it. When done, call run_checks to confirm, then reply with a one-paragraph summary.",
      prompt: `Project: ${p.name}\nFailing step: ${failure?.name}\nOutput (tail):\n${failure?.output.slice(-6000)}\n\nFiles: ${[...map.keys()].join(", ")}`,
      maxTurns: 14,
      tools: [
        { name: "read_file", description: "Read a project file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
        {
          name: "write_file",
          description: "Create or replace a project file (full content)",
          inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
        },
        { name: "run_checks", description: "Run install, typecheck, build and tests in the isolated sandbox", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
      ],
      runTool: async (name, input) => {
        if (name === "read_file") {
          const f = map.get(String(input.path));
          if (!f) return { content: `No such file: ${input.path}`, isError: true };
          return { content: Buffer.isBuffer(f.content) ? "(binary file)" : f.content };
        }
        if (name === "write_file") {
          const path = String(input.path).replace(/^\.?\//, "");
          if (path.includes("..") || path.startsWith("/")) return { content: "Invalid path", isError: true };
          map.set(path, { path, content: String(input.content) });
          return { content: `Wrote ${path}` };
        }
        if (name === "run_checks") {
          const current = [...map.values()];
          const blocked = scanProject(current).filter((f) => f.severity === "block");
          if (blocked.length) return { content: `Security scan blocked: ${blocked.map((b) => `${b.file}: ${b.detail}`).join("; ")}`, isError: true };
          sbx ??= await createSandbox(ctx);
          await sbx.writeFiles(current);
          const gate = await runQualityGate(sbx);
          return { content: gate.steps.map((s) => `${s.name}: ${s.ok ? "ok" : `FAILED\n${s.output.slice(-3000)}`}`).join("\n"), isError: !gate.ok };
        }
        return { content: `Unknown tool ${name}`, isError: true };
      },
    },
    { purpose: "build.repair", workspaceId: p.workspaceId },
  ).finally(async () => {
    if (sbx) await (sbx as Sandbox).stop();
  });
  const newFiles = [...map.values()];
  const digest = digestFiles(newFiles);
  if (digest === p.filesDigest) return null;
  const revision = p.revision + 1;
  await putFiles(ctx, p.id, revision, newFiles);
  const next: BuildProject = { ...p, revision, filesDigest: digest, repairs: [...p.repairs, { revision, summary: res.finalText.slice(0, 1000), at: ctx.now().toISOString() }] };
  await save(ctx, next);
  return next;
}

// ---------------------------------------------------------------------------
// 5. GitHub: repository, branch, commit, pull request
// ---------------------------------------------------------------------------

export async function publishToGithub(ctx: Ctx, projectId: string, requestedBy = "bingo"): Promise<BuildProject> {
  const p = (await getProject(ctx, projectId))!;
  const auth = await gh.githubAuth(ctx);
  if (!auth) {
    p.notes.push("GitHub not connected — source kept in BINGO only. Connect GitHub to version the code.");
    return save(ctx, p);
  }
  let repo = p.repo ? await gh.allowedRepo(ctx, `${p.repo.owner}/${p.repo.name}`) : null;
  if (!repo) {
    const decision = await authorize(ctx, { kind: "repo.create", workspaceId: p.workspaceId, payload: { name: p.slug }, title: `Create GitHub repository ${p.slug}`, summary: `Private repository for ${p.name}`, requestedBy });
    if (!decision.allowed) throw new Error(decision.reason);
    repo = await gh.createRepo(ctx, { name: p.slug, description: `${p.name} — generated by BINGO`, private: true });
  }
  const branch = `bingo/r${p.revision}`;
  await gh.createBranch(ctx, repo.owner, repo.name, branch, repo.defaultBranch);
  const commitAuth = await authorize(ctx, { kind: "repo.commit", workspaceId: p.workspaceId, payload: { repo: repo.id, branch, digest: p.filesDigest }, title: `Commit ${p.name} r${p.revision}`, summary: branch, requestedBy });
  if (!commitAuth.allowed) throw new Error(commitAuth.reason);
  const files = await getFiles(ctx, p.id, p.revision);
  const commit = await gh.commitFiles(ctx, repo.owner, repo.name, branch, files, `BINGO: ${p.name} revision ${p.revision}`);
  const lastCheck = p.checks.at(-1);
  const pr = await gh.openPullRequest(ctx, repo.owner, repo.name, {
    title: `${p.name} — revision ${p.revision}`,
    head: branch,
    base: repo.defaultBranch,
    body: `Generated by BINGO DEVELOPER.\n\n**Request:** ${p.request}\n\n**Checks (r${lastCheck?.revision ?? "-"}):** ${lastCheck ? lastCheck.steps.map((s) => `${s.name} ${s.ok ? "✅" : "❌"}`).join(" · ") : "not run"}\n\n**Compliance:** ${p.compliance?.status ?? "n/a"}`,
  });
  const next: BuildProject = { ...p, repo: { owner: repo.owner, name: repo.name, branch, prUrl: pr.url, commitSha: commit.sha, htmlUrl: repo.htmlUrl } };
  await logActivity(ctx, { actor: requestedBy, action: "build.github", summary: `Committed ${commit.sha.slice(0, 7)} to ${repo.id}@${branch} and opened PR #${pr.number}`, level: "success", workspaceId: p.workspaceId, ref: { kind: "project", id: p.id } });
  return save(ctx, next);
}

// ---------------------------------------------------------------------------
// 6. Vercel: preview deployment → verify → production (approval) → verify live
// ---------------------------------------------------------------------------

async function ensureVercelProject(ctx: Ctx, p: BuildProject): Promise<NonNullable<BuildProject["vercelProject"]>> {
  if (p.vercelProject) return p.vercelProject;
  let secret = await ctx.vault.get(p.workspaceId, `lead_secret:${p.id}`);
  if (!secret) {
    secret = randomBytes(24).toString("hex");
    await ctx.vault.set(p.workspaceId, `lead_secret:${p.id}`, secret);
  }
  const vp = await vercel.createProject(ctx, p.slug, {
    env: [
      { key: "BINGO_INTAKE_URL", value: `${ctx.env.publicUrl}/api/intake/lead?project=${p.id}`, target: ["production", "preview"] },
      { key: "LEAD_SIGNING_SECRET", value: secret, target: ["production", "preview"] },
    ],
  });
  const owned = await ctx.store.get<{ id: string }>("vercel_owned", vp.id);
  if (vp.created) await ctx.store.put("vercel_owned", { id: vp.id, projectId: p.id });
  return { id: vp.id, name: vp.name, createdByBingo: vp.created || !!owned };
}

export async function deployPreview(ctx: Ctx, projectId: string, requestedBy = "bingo"): Promise<BuildProject> {
  let p: BuildProject = (await getProject(ctx, projectId))!;
  const last = p.checks.at(-1);
  if (!last || last.revision !== p.revision || !last.ok) throw new Error("Checks must pass for this revision before a preview is deployed.");
  const policy = await getPolicy(ctx, p.workspaceId);
  if ((await countToday(ctx, "deploy.preview")) >= policy.limits.previewDeploysPerDay) throw new Error(`Daily preview limit (${policy.limits.previewDeploysPerDay}) reached.`);
  const auth = await authorize(ctx, { kind: "deploy.preview", workspaceId: p.workspaceId, payload: { projectId: p.id, revision: p.revision, digest: p.filesDigest }, title: `Preview deploy ${p.name}`, summary: `Revision ${p.revision}`, requestedBy });
  if (!auth.allowed) throw new Error(auth.reason);
  const vp = await ensureVercelProject(ctx, p);
  p = { ...p, vercelProject: vp };
  const files = await getFiles(ctx, p.id, p.revision);
  const d = await vercel.deployFiles(ctx, { projectName: vp.name, files, target: "preview", meta: { bingoProject: p.id, revision: String(p.revision) } });
  await recordAction(ctx, "deploy.preview", { projectId: p.id, deploymentId: d.id });
  const rec: DeploymentRec = { id: d.id, target: "preview", url: `https://${d.url}`, state: d.readyState, revision: p.revision, filesDigest: p.filesDigest, createdAt: ctx.now().toISOString() };
  p = { ...p, deployments: [...p.deployments, rec] };
  await logActivity(ctx, { actor: requestedBy, action: "build.preview.created", summary: `Preview deployment created for ${p.name}: ${rec.url} (${d.readyState})`, workspaceId: p.workspaceId, ref: { kind: "project", id: p.id } });
  return save(ctx, p);
}

/** Polls a deployment. Returns "pending" while Vercel is still building. */
export async function pollDeployment(ctx: Ctx, projectId: string, deploymentId: string): Promise<{ project: BuildProject; state: "pending" | "ready" | "error" }> {
  const p = (await getProject(ctx, projectId))!;
  const d = await vercel.getDeployment(ctx, deploymentId);
  const idx = p.deployments.findIndex((x) => x.id === deploymentId);
  if (idx < 0) throw new Error("Unknown deployment");
  const rec = { ...p.deployments[idx]!, state: d.readyState, url: d.url ? `https://${d.url}` : p.deployments[idx]!.url };
  if (d.readyState === "ERROR") rec.logsTail = (await vercel.deploymentLogs(ctx, deploymentId).catch(() => [])).slice(-60);
  p.deployments[idx] = rec;
  if (d.readyState === "READY" || d.readyState === "ERROR" || d.readyState === "CANCELED") {
    const verified = d.readyState === "READY" ? await verifyUrl(ctx, rec.url, p) : undefined;
    if (verified) p.deployments[idx] = { ...rec, verified };
    p.status = d.readyState !== "READY" ? "failed" : rec.target === "production" ? (verified?.ok ? "live" : "failed") : "preview_ready";
    if (rec.target === "production" && verified?.ok) p.liveUrl = d.alias?.[0] ? `https://${d.alias[0]}` : rec.url;
    await save(ctx, p);
    await syncDeploymentSheet(ctx, p, p.deployments[idx]!);
    await logActivity(ctx, {
      actor: "bingo",
      action: `build.${rec.target}.${d.readyState.toLowerCase()}`,
      summary:
        d.readyState === "READY"
          ? `${rec.target === "production" ? "Production" : "Preview"} ready: ${rec.target === "production" ? p.liveUrl : rec.url}${verified ? ` — verification ${verified.ok ? "passed" : `FAILED (${verified.detail})`}` : ""}`
          : `${rec.target} deployment ${d.readyState}: ${d.errorMessage ?? rec.logsTail?.slice(-3).join(" ") ?? ""}`,
      level: d.readyState === "READY" && verified?.ok !== false ? "success" : "error",
      workspaceId: p.workspaceId,
      ref: { kind: "project", id: p.id },
    });
    return { project: p, state: d.readyState === "READY" ? "ready" : "error" };
  }
  await save(ctx, p);
  return { project: p, state: "pending" };
}

async function verifyUrl(ctx: Ctx, url: string, p: BuildProject) {
  try {
    const r = await vercel.fetchDeployed(ctx, url);
    const headline = p.content[p.spec.locales[0]!]?.hero.headline ?? "";
    if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, detail: "Deployment is protected (Vercel Authentication). Add a Protection Bypass for Automation secret in Settings → Connections → Vercel so BINGO can verify it.", at: ctx.now().toISOString() };
    const okHtml = r.status === 200 && (/<h1/.test(r.html) || p.spec.locales.length > 1) && (!headline || r.html.includes(headline.slice(0, 20)) || p.spec.locales.length > 1);
    return { ok: okHtml, status: r.status, detail: okHtml ? "HTTP 200, page content matches" : `HTTP ${r.status}, expected content not found`, at: ctx.now().toISOString() };
  } catch (e) {
    return { ok: false, status: 0, detail: errorMessage(e), at: ctx.now().toISOString() };
  }
}

export async function requestProduction(ctx: Ctx, projectId: string, opts: { approvalId?: string; requestedBy?: string; workflowId?: string; stepId?: string } = {}): Promise<{ project: BuildProject; status: "deploying" | "awaiting_approval" | "blocked"; approvalId?: string; reason?: string }> {
  let p: BuildProject = (await getProject(ctx, projectId))!;
  const preview = [...p.deployments].reverse().find((d) => d.target === "preview" && d.state === "READY" && d.revision === p.revision);
  if (!preview) return { project: p, status: "blocked", reason: "A verified preview of the current revision is required before production." };
  if (p.compliance?.status === "blocked") return { project: p, status: "blocked", reason: "Copy has blocking compliance issues." };
  const existingLive = p.vercelProject && !p.vercelProject.createdByBingo;
  const payload = { projectId: p.id, vercelProject: p.vercelProject?.name, revision: p.revision, digest: p.filesDigest, preview: preview.url };
  const auth = await authorize(ctx, {
    kind: "deploy.production",
    workspaceId: p.workspaceId,
    payload,
    title: `Publish ${p.name} to production`,
    summary: `Preview: ${preview.url}\nRevision ${p.revision} (files ${p.filesDigest.slice(0, 12)})${existingLive ? "\n⚠️ This Vercel project existed before BINGO — publishing replaces its live site." : ""}${p.translationReview.length ? `\nTranslations flagged for review: ${p.translationReview.map((t) => t.locale).join(", ")}` : ""}`,
    requestedBy: opts.requestedBy ?? "bingo",
    approvalId: opts.approvalId,
    workflowId: opts.workflowId,
    stepId: opts.stepId,
  });
  if (!auth.allowed) {
    p = { ...p, status: auth.approval ? "awaiting_production_approval" : p.status };
    await save(ctx, p);
    return { project: p, status: auth.approval ? "awaiting_approval" : "blocked", approvalId: auth.approval?.id, reason: auth.reason };
  }
  const files = await getFiles(ctx, p.id, p.revision);
  if (digestFiles(files) !== p.filesDigest) throw new Error("Files changed after approval — refusing to deploy.");
  const d = await vercel.deployFiles(ctx, { projectName: p.vercelProject!.name, files, target: "production", meta: { bingoProject: p.id, revision: String(p.revision), approval: auth.approvalId ?? auth.via } });
  p = { ...p, deployments: [...p.deployments, { id: d.id, target: "production", url: `https://${d.url}`, state: d.readyState, revision: p.revision, filesDigest: p.filesDigest, createdAt: ctx.now().toISOString(), approvalId: auth.approvalId }] };
  await logActivity(ctx, { actor: "owner", action: "build.production.started", summary: `Production deployment started for ${p.name} (approved)`, level: "success", workspaceId: p.workspaceId, ref: { kind: "project", id: p.id } });
  await save(ctx, p);
  return { project: p, status: "deploying" };
}

export async function rollback(ctx: Ctx, projectId: string, toDeploymentId: string, approvalId?: string) {
  const p = (await getProject(ctx, projectId))!;
  if (!p.vercelProject) throw new Error("Not deployed yet");
  const auth = await authorize(ctx, { kind: "deploy.rollback", workspaceId: p.workspaceId, payload: { projectId: p.id, to: toDeploymentId }, title: `Roll back ${p.name}`, summary: `Restore production deployment ${toDeploymentId}`, requestedBy: "owner", approvalId });
  if (!auth.allowed) return { status: "awaiting_approval" as const, approvalId: auth.approval?.id, reason: auth.reason };
  await vercel.rollbackTo(ctx, p.vercelProject.id, toDeploymentId);
  await logActivity(ctx, { actor: "owner", action: "build.rollback", summary: `Rolled back ${p.name} to ${toDeploymentId}`, level: "warning", workspaceId: p.workspaceId });
  return { status: "done" as const };
}

export async function connectDomain(ctx: Ctx, projectId: string, domain: string, approvalId?: string) {
  const p = (await getProject(ctx, projectId))!;
  if (!p.vercelProject) throw new Error("Deploy first");
  const auth = await authorize(ctx, { kind: "domain.change", workspaceId: p.workspaceId, payload: { projectId: p.id, domain }, title: `Connect ${domain} to ${p.name}`, summary: `Adds ${domain} to Vercel project ${p.vercelProject.name}`, requestedBy: "owner", approvalId });
  if (!auth.allowed) return { status: "awaiting_approval" as const, approvalId: auth.approval?.id };
  const r = await vercel.addDomain(ctx, p.vercelProject.id, domain);
  return { status: "done" as const, verified: r.verified, verification: r.verification };
}

async function syncDeploymentSheet(ctx: Ctx, p: BuildProject, d: DeploymentRec) {
  await pushToSheet(ctx, "deployments", [
    { "BINGO ID": d.id, Project: p.name, Environment: d.target, URL: d.target === "production" && p.liveUrl ? p.liveUrl : d.url, Status: d.state, Commit: p.repo?.commitSha?.slice(0, 7) ?? `r${d.revision}`, Created: d.createdAt, "Approved By": d.approvalId ? "owner" : "" },
  ]);
}

/** Lets an owner change copy after review; runs compliance again and produces a new revision. */
export async function updateContent(ctx: Ctx, projectId: string, locale: string, json: string) {
  const p = (await getProject(ctx, projectId))!;
  const parsed = LandingContentSchema.parse(extractJson(json));
  const kit = (await brandKitForWorkspace(ctx, p.workspaceId))!;
  const product = p.productId ? (kit.products.find((x) => x.id === p.productId) ?? null) : null;
  const content = { ...p.content, [locale]: parsed };
  const compliance = checkCompliance([parsed.hero.headline, parsed.hero.subline, ...parsed.benefits.map((b) => `${b.title}. ${b.body}`)].join("\n"), kit, product);
  await save(ctx, { ...p, content, compliance, status: "content_ready" });
  return generateFiles(ctx, projectId);
}

export const DeveloperSchemas = { z };
