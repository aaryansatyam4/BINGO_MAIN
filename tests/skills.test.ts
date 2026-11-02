import { afterEach, describe, expect, it } from "vitest";
import { setAdapterFactory } from "@/ai/engine";
import { applyPreferences, emitEvent, learnSkill, listSkills, skillFeedback, validateSkill } from "@/skills/engine";
import { planRequest } from "@/orchestrator/planner";
import { connectFakeAi } from "./fakes/ai";
import { testCtx } from "./helpers";

afterEach(() => setAdapterFactory(null));

describe("self-learning skills", () => {
  it("learns the owner's example instructions as validated, editable skills", async () => {
    const ctx = testCtx();
    const a = await learnSkill(ctx, "Whenever I ask for a landing page, use our approved Carpediem design system.");
    expect(a).toMatchObject({ kind: "preference", status: "active", trigger: { type: "request", intents: ["build.landing"] }, effect: { setParams: { brandKitId: "brand_carpediem" } } });
    const b = await learnSkill(ctx, "Whenever I ask for distributor outreach in Russia, prepare the communication in Russian.");
    expect(b).toMatchObject({ trigger: { intents: ["global.outreach"], match: { country: "RU" } }, effect: { setParams: { language: "ru" } } });
    const c = await learnSkill(ctx, "Always send a preview before publishing a new website.");
    expect(c.kind).toBe("policy");
    expect(c.effect.note).toMatch(/Already enforced/);
    const d = await learnSkill(ctx, "Send all approved deployment results to Telegram.");
    expect(d).toMatchObject({ kind: "workflow", trigger: { type: "event", event: "deployment.production.live" } });
    const e = await learnSkill(ctx, "Whenever a distributor meeting is confirmed, create a follow-up task in my existing company Google Sheet.");
    expect(e.effect.workflow![0]!.type).toBe("tasks.create");
    expect((await listSkills(ctx)).every((s) => s.validation.ok)).toBe(true);
  });

  it("acceptance test 5: “Every time we launch a new product, create a landing-page draft and marketing creative proposal.”", async () => {
    const ctx = testCtx();
    const s = await learnSkill(ctx, "Every time we launch a new product, create a landing-page draft and marketing creative proposal.");
    expect(s.status).toBe("active");
    expect(s.trigger).toMatchObject({ type: "event", event: "product.launched" });
    expect(s.effect.workflow!.map((x) => x.type)).toEqual(["build.plan", "build.content", "build.files", "build.checks", "studio.generate"]);
    expect(s.validation.ok).toBe(true);
    // Fires as a durable workflow when a product launch happens; no deployment or outreach is included.
    const [wfId] = await emitEvent(ctx, "product.launched", { product: "DeepRest", workspaceId: "ws_carpediem" });
    const wf = (await ctx.store.get<{ steps: { type: string; params: Record<string, unknown>; deps: string[] }[]; source: { kind: string } }>("workflows", wfId!))!;
    expect(wf.source.kind).toBe("skill");
    expect(wf.steps[0]!.params.request).toBe("Landing page for DeepRest");
    expect(wf.steps[1]!.params.projectId).toEqual({ $ref: "s1.projectId" });
    expect(wf.steps[1]!.deps).toEqual(["s1"]);
    expect(wf.steps.some((x) => x.type.startsWith("build.production") || x.type === "global.send")).toBe(false);
    // Saying it again updates the same skill (new version) rather than duplicating it.
    const again = await learnSkill(ctx, "Every time we launch a new product, create a landing-page draft and marketing creative proposal.");
    expect(again.id).toBe(s.id);
    expect(again.version).toBe(2);
  });

  it("applies preferences when planning and improves them from explicit feedback", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx);
    const s = await learnSkill(ctx, "Whenever I ask for distributor outreach in Russia, prepare the communication in English.");
    await skillFeedback(ctx, s.id, "Use Russian instead", 1);
    const pref = await applyPreferences(ctx, "global.outreach", { country: "RU", text: "x" });
    expect(pref.params.language).toBe("ru");
    const plan = await planRequest(ctx, "Find 10 pharmaceutical distributors in Russia and prepare our outreach");
    expect(plan.steps.find((x) => x.type === "global.draft")!.params.language).toBe("ru");
    expect(plan.applied[0]!.name).toMatch(/Preference/);
  });

  it("rejects skills that reference unknown abilities or try to touch approvals", () => {
    const v = validateSkill({ kind: "workflow", trigger: { type: "event", event: "meeting.confirmed", match: {} }, effect: { workflow: [{ type: "shell.exec", params: {} }, { type: "build.production", params: { approvalId: "apr_x" } }] } });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/Unknown step type "shell.exec"/);
    expect(v.errors.join(" ")).toMatch(/may not set "approvalId"/);
  });
});
