import { afterEach, describe, expect, it } from "vitest";
import { setAdapterFactory } from "@/ai/engine";
import { makeCtx } from "@/core/context";
import { decideApproval, listApprovals, setKillSwitch } from "@/core/policy";
import { saveOwner } from "@/core/settings";
import { FileStore } from "@/core/store";
import { setSandboxFactory } from "@/build/sandbox";
import { githubConnectToken } from "@/integrations/github";
import { vercelConnectToken } from "@/integrations/vercel";
import { askBingo, planRequest } from "@/orchestrator/planner";
import { tick } from "@/orchestrator/scheduler";
import { controlWorkflow, createWorkflow, getWorkflow, modifyStep, runWorkflows, setHandlers } from "@/orchestrator/workflow";
import { connectFakeAi } from "./fakes/ai";
import { World } from "./fakes/world";
import { connectGoogle, UZ_RESEARCH, uzWorld } from "./fixtures";
import { testCtx } from "./helpers";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

afterEach(() => {
  setAdapterFactory(null);
  setSandboxFactory(null);
  setHandlers(null);
});

const okSandbox = async () => ({ kind: "local" as const, writeFiles: async () => undefined, run: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false }), readFile: async () => null, stop: async () => undefined });

describe("Ask BINGO planner", () => {
  it("turns the multi-skill request into one dependency-ordered plan", async () => {
    const ctx = testCtx();
    const plan = await planRequest(ctx, "BINGO, create a Russian distributor landing page, generate the images, deploy it to Vercel, and send the approved page to our shortlisted distributors.");
    const types = plan.steps.map((s) => s.type);
    expect(types).toEqual(["build.plan", "build.content", "studio.generate", "build.files", "build.checks", "build.github", "build.preview", "build.production", "global.share_page", "global.send"]);
    expect(plan.steps[0]!.params).toMatchObject({ kind: "distributor", locales: ["ru"] });
    expect(plan.steps.find((s) => s.type === "global.share_page")!.deps).toContain("production");
  });

  it("plans research + Russian outreach, reports, meetings and policy changes", async () => {
    const ctx = testCtx();
    const p1 = await planRequest(ctx, "BINGO, find 30 pharmaceutical distributors in Uzbekistan and prepare our outreach in Russian.");
    expect(p1.steps.map((s) => s.type)).toEqual(["global.research", "global.draft", "global.send"]);
    expect(p1.steps[0]!.params).toMatchObject({ country: "UZ", count: 30 });
    expect(p1.steps[1]!.params).toMatchObject({ language: "ru", leadIds: { $ref: "research.leadIds" } });
    const p2 = await planRequest(ctx, "BINGO, make a complete expansion report for Cambodia, create supporting charts, and send it to my Gmail and Telegram.");
    expect(p2.steps.map((s) => s.type)).toEqual(["report.generate", "report.deliver"]);
    expect(p2.steps[0]!.params.country).toBe("KH");
    expect(p2.steps[1]!.params.channels).toEqual(["email", "telegram"]);
    const p3 = await planRequest(ctx, "BINGO, arrange meetings next week with the distributors who responded positively.");
    expect(p3.steps.map((s) => s.type)).toEqual(["calendar.propose", "global.send"]);
    const p4 = await planRequest(ctx, "BINGO, call me immediately for all major business emergencies, but send routine matters to Telegram.");
    expect(p4.steps.map((s) => s.type)).toEqual(["speak.policy"]);
    const p5 = await planRequest(ctx, "Create five premium advertising creatives for Carpediem SleepTime.");
    expect(p5.steps[0]).toMatchObject({ type: "studio.generate", params: { count: 5, productId: "prod_sleeptime" } });
  });

  it("explains instead of guessing when it cannot plan", async () => {
    const ctx = testCtx();
    const r = await askBingo(ctx, "Do something nice");
    expect(r.workflow).toBeNull();
    expect(r.plan.notes.join(" ")).toMatch(/no reasoning model is connected/);
  });
});

describe("durable execution", () => {
  it("runs steps in dependency order, waits at approvals, and resumes after approval", async () => {
    const ctx = testCtx();
    const order: string[] = [];
    setHandlers({
      "global.research": async () => (order.push("research"), { status: "done", result: { leadIds: ["l1", "l2"] }, summary: "2 leads" }),
      "global.draft": async (sc) => (order.push(`draft:${(sc.params.leadIds as string[]).join(",")}`), { status: "done", result: { messageIds: ["m1"] }, summary: "1 draft" }),
      "global.send": async (sc) => {
        if (!sc.step.approvalId) {
          const { requestApproval } = await import("@/core/policy");
          const a = await requestApproval(ctx, { kind: "email.send.initial", title: "Send", summary: "", payload: { m: 1 }, requestedBy: "t" });
          return { status: "needs_approval", approvalId: a.id, summary: "waiting" };
        }
        order.push("send");
        return { status: "done", result: {}, summary: "sent" };
      },
    });
    const wf = await createWorkflow(ctx, { goal: "g", source: { kind: "ask" }, steps: [{ id: "research", type: "global.research", params: {} }, { id: "draft", type: "global.draft", params: { leadIds: { $ref: "research.leadIds" } } }, { id: "send", type: "global.send", params: {} , deps: ["draft"] }] });
    await runWorkflows(ctx);
    let w = (await getWorkflow(ctx, wf.id))!;
    expect(order).toEqual(["research", "draft:l1,l2"]);
    expect(w.steps[2]!.status).toBe("waiting_approval");
    expect(w.status).toBe("running");
    const [a] = await listApprovals(ctx);
    await decideApproval(ctx, a!.id, "approved", "test");
    await runWorkflows(ctx);
    w = (await getWorkflow(ctx, wf.id))!;
    expect(order.at(-1)).toBe("send");
    expect(w.status).toBe("completed");
  });

  it("rejection skips dependents; pause, cancel, modify and retry work", async () => {
    const ctx = testCtx();
    let fail = true;
    setHandlers({
      "notify.telegram": async (sc) => {
        if (fail) throw Object.assign(new Error("boom"), {});
        return { status: "done", result: {}, summary: String(sc.params.text) };
      },
      "tasks.create": async () => ({ status: "done", result: {}, summary: "task" }),
    });
    const wf = await createWorkflow(ctx, { goal: "g", source: { kind: "ui" }, steps: [{ id: "a", type: "notify.telegram", params: { text: "hi" } }, { id: "b", type: "tasks.create", params: { title: "t" }, deps: ["a"] }] });
    await controlWorkflow(ctx, wf.id, "pause");
    await runWorkflows(ctx);
    expect((await getWorkflow(ctx, wf.id))!.steps[0]!.status).toBe("pending");
    await controlWorkflow(ctx, wf.id, "resume");
    await modifyStep(ctx, wf.id, "a", { params: { text: "changed" } });
    await expect(modifyStep(ctx, wf.id, "a", { params: { approvalId: "x" } })).rejects.toThrow(/not valid/);
    for (let i = 0; i < 3; i++) {
      await runWorkflows(ctx);
      const w = (await getWorkflow(ctx, wf.id))!;
      // fast-forward retry back-off
      w.steps[0]!.resumeAt = new Date(0).toISOString();
      await ctx.store.put("workflows", w);
    }
    let w = (await getWorkflow(ctx, wf.id))!;
    expect(w.steps[0]!.status).toBe("failed");
    expect(w.steps[1]!.status).toBe("skipped");
    fail = false;
    await modifyStep(ctx, wf.id, "a", { retry: true });
    await runWorkflows(ctx);
    w = (await getWorkflow(ctx, wf.id))!;
    expect(w.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(w.steps[0]!.summary).toBe("changed");
    const wf2 = await createWorkflow(ctx, { goal: "g2", source: { kind: "ui" }, steps: [{ type: "tasks.create", params: {} }] });
    await controlWorkflow(ctx, wf2.id, "cancel");
    await runWorkflows(ctx);
    expect((await getWorkflow(ctx, wf2.id))!.steps[0]!.status).toBe("cancelled");
  });

  it("emergency stop halts all workflows", async () => {
    const ctx = testCtx();
    let ran = 0;
    setHandlers({ "tasks.create": async () => (ran++, { status: "done", summary: "" }) });
    await createWorkflow(ctx, { goal: "g", source: { kind: "ui" }, steps: [{ type: "tasks.create", params: {} }] });
    await setKillSwitch(ctx, "global", true, "test");
    expect(await tick(ctx)).toHaveProperty("suspended");
    await runWorkflows(ctx);
    expect(ran).toBe(0);
  });

  it("acceptance test 6: work continues in the cloud after the browser closes; history shows real outcomes", async () => {
    // Process 1 (the web request): plan & create the workflow, then "close the browser".
    const dir = await mkdtemp(path.join(tmpdir(), "bingo-durable-"));
    const world = uzWorld();
    const ctx1 = makeCtx({ store: new FileStore(dir), fetch: world.fetch });
    await connectFakeAi(ctx1, UZ_RESEARCH);
    await connectGoogle(ctx1);
    await saveOwner(ctx1, { email: "owner@carpediem.example", preferredLanguage: "en" });
    const { workflow } = await askBingo(ctx1, "Find 10 pharmaceutical distributors in Uzbekistan and prepare our outreach in Russian.");
    expect(workflow).not.toBeNull();

    // Process 2 (cron worker, fresh memory, same database): advances the work.
    const ctx2 = makeCtx({ store: new FileStore(dir), fetch: world.fetch });
    await tick(ctx2, { only: ["workflows"] });
    let w = (await getWorkflow(ctx2, workflow!.id))!;
    expect(w.steps.map((s) => s.status)).toEqual(["done", "done", "waiting_approval"]);
    expect(w.steps[0]!.summary).toMatch(/3 new leads saved \(2 verified/);
    expect(w.steps[0]!.usage.aiCalls).toBeGreaterThan(0);
    expect(world.sentEmails).toHaveLength(0);

    // Owner returns, approves from the dashboard; another worker run sends for real.
    const ctx3 = makeCtx({ store: new FileStore(dir), fetch: world.fetch });
    const [a] = await listApprovals(ctx3);
    await decideApproval(ctx3, a!.id, "approved", "dashboard");
    const { savePolicy } = await import("@/core/policy");
    await savePolicy(ctx3, "global", { limits: { minSecondsBetweenEmails: 0, initialEmailsPerDay: 10, initialEmailsPerDomainPerDay: 2, previewDeploysPerDay: 5, callsPerDay: 2 } });
    await tick(makeCtx({ store: new FileStore(dir), fetch: world.fetch }), { only: ["workflows"] });
    w = (await getWorkflow(ctx3, workflow!.id))!;
    expect(w.status).toBe("completed");
    expect(w.steps[2]!.summary).toBe("Submitted to Gmail: 2/2");
    expect(world.sentEmails).toHaveLength(2);
    const sent = w.steps[2]!.result!.sent as { gmailId: string }[];
    expect(sent.map((s) => s.gmailId).sort()).toEqual(world.sentEmails.map((e) => e.id).sort());
    const activity = await ctx3.store.list<{ action: string; summary: string }>("activity");
    expect(activity.some((x) => x.action === "outreach.sent" && /Emails submitted to Gmail: 2/.test(x.summary))).toBe(true);
  });

  it("runs a full website workflow up to the production approval gate", async () => {
    const world = new World();
    const ctx = testCtx(world.fetch);
    await connectFakeAi(ctx);
    await saveOwner(ctx, { preferredLanguage: "en" });
    await githubConnectToken(ctx, "gho");
    await vercelConnectToken(ctx, "vc");
    setSandboxFactory(okSandbox);
    const { workflow } = await askBingo(ctx, "Create a premium SleepTime landing page.");
    for (let i = 0; i < 6; i++) {
      await runWorkflows(ctx);
      const w = (await getWorkflow(ctx, workflow!.id))!;
      for (const s of w.steps) if (s.status === "waiting") s.resumeAt = new Date(0).toISOString();
      await ctx.store.put("workflows", w);
    }
    const w = (await getWorkflow(ctx, workflow!.id))!;
    const byType = Object.fromEntries(w.steps.map((s) => [s.type, s]));
    expect(byType["build.preview"]!.status).toBe("done");
    expect(byType["build.preview"]!.result!.previewUrl).toMatch(/vercel\.app/);
    expect(byType["build.production"]!.status).toBe("waiting_approval");
    expect([...world.deployments.values()].some((d) => d.target === "production")).toBe(false);
  });
});
