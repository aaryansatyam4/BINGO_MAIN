import { afterEach, describe, expect, it } from "vitest";
import { setAdapterFactory } from "@/ai/engine";
import { getBrandKit, saveAsset, saveBrandKit } from "@/studio/brand";
import { checkCompliance } from "@/studio/claims";
import { checkReadability, layoutCreative, renderSvg, worstContrast } from "@/studio/compose";
import { editCreative, generateCreatives, parseEditInstruction, renderCreativeSvg, setCreativeStatus } from "@/studio/creative";
import { connectFakeAi } from "./fakes/ai";
import { testCtx } from "./helpers";

afterEach(() => setAdapterFactory(null));

async function kitWithPackshot(ctx: ReturnType<typeof testCtx>, claims = true) {
  const kit = (await getBrandKit(ctx, "brand_carpediem"))!;
  const pack = await saveAsset(ctx, { workspaceId: "ws_carpediem", name: "sleeptime.png", mime: "image/png", b64: Buffer.from("approved-packshot").toString("base64"), width: 400, height: 800, kind: "packshot", approved: true, source: "upload" });
  kit.products[0]!.packshotAssetIds = [pack.id];
  if (claims) kit.products[0]!.approvedClaims = [{ id: "c1", text: "Supports a calm evening routine", approvedBy: "owner" }];
  kit.products[0]!.facts = ["30 capsules per pack"];
  await saveBrandKit(ctx, kit);
  return { kit: (await getBrandKit(ctx, "brand_carpediem"))!, pack };
}

describe("approved-claims compliance", () => {
  it("blocks medical claims, testimonials, uncertified badges and invented numbers", async () => {
    const ctx = testCtx();
    const { kit } = await kitWithPackshot(ctx);
    const product = kit.products[0]!;
    expect(checkCompliance("Supports a calm evening routine. 30 capsules per pack.", kit, product).status).toBe("pass");
    const bad = checkCompliance("Cures insomnia in 7 days. “Best sleep of my life” — Priya. FDA approved formula.", kit, product);
    expect(bad.status).toBe("blocked");
    const reasons = bad.issues.map((i) => i.reason).join(" | ");
    expect(reasons).toMatch(/Medical|disease/i);
    expect(reasons).toMatch(/Testimonial/i);
    expect(reasons).toMatch(/Forbidden phrase|Certification/);
    expect(reasons).toMatch(/Number "7/);
    expect(checkCompliance("Improves deep sleep by 40%.", kit, product).status).not.toBe("pass");
  });
});

describe("composition & readability", () => {
  it("guarantees text contrast over unknown photographic backgrounds with a scrim", async () => {
    const ctx = testCtx();
    const { kit } = await kitWithPackshot(ctx);
    const spec = layoutCreative(kit, "instagram-square", { headline: "Quiet evenings", subline: "A calm ritual", cta: "Discover", disclaimer: "" }, { backgroundAssetId: "bg1", productAssetId: "p1" });
    expect(spec.scrim).not.toBeNull();
    expect(worstContrast(spec.headline.color, spec)).toBeGreaterThanOrEqual(3);
    expect(checkReadability(spec).ok).toBe(true);
    const svg = renderSvg(spec, new Map([["p1", { mime: "image/png", b64: "AAA" }], ["bg1", { mime: "image/png", b64: "BBB" }]]));
    expect(svg).toContain('data-layer="product"');
    expect(svg).toContain("Quiet evenings");
  });
  it("produces every requested aspect ratio", async () => {
    const ctx = testCtx();
    const { kit } = await kitWithPackshot(ctx);
    for (const f of ["instagram-portrait", "story", "web-hero", "ecommerce-banner"]) {
      const s = layoutCreative(kit, f, { headline: "Rest, by design", subline: "Premium wellness, presented with care.", cta: "Explore", disclaimer: "" }, { productAssetId: "p" });
      expect(checkReadability(s).ok, f).toBe(true);
    }
  });
});

describe("BINGO STUDIO pipeline", () => {
  it("“Create five premium advertising creatives for Carpediem SleepTime” → concepts, copy, images, formats, checks", async () => {
    const ctx = testCtx();
    const calls: { capability: string; system?: string; prompt: string; model: string }[] = [];
    await connectFakeAi(ctx, { calls });
    const { kit, pack } = await kitWithPackshot(ctx);
    const r = await generateCreatives(ctx, { workspaceId: "ws_carpediem", brandKitId: kit.id, productId: "prod_sleeptime", brief: "five premium advertising creatives", count: 5, formats: ["instagram-square", "story", "web-hero"] });
    expect(r.creatives).toHaveLength(5);
    // Brand context with approved claims went to the copywriter.
    expect(calls[0]!.system).toContain("[c1] Supports a calm evening routine");
    expect(calls[0]!.system).toContain("Never invent packaging");
    for (const c of r.creatives) {
      const v = c.versions[0]!;
      expect(v.specs.map((s) => s.format)).toEqual(["instagram-square", "story", "web-hero"]);
      expect(v.specs.every((s) => s.product?.assetId === pack.id)).toBe(true);
      expect(v.specs.every((s) => s.background.kind === "image")).toBe(true);
      expect(v.readability.every((x) => x.report.ok)).toBe(true);
    }
    const svg = await renderCreativeSvg(ctx, r.creatives[0]!);
    expect(svg).toContain(Buffer.from("approved-packshot").toString("base64"));
  });

  it("is honest when no image provider is connected", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx, {}, ["anthropic"]);
    const { kit } = await kitWithPackshot(ctx, false);
    const r = await generateCreatives(ctx, { workspaceId: "ws_carpediem", brandKitId: kit.id, productId: "prod_sleeptime", brief: "ads", count: 1, formats: ["instagram-square"] });
    expect(r.notes.join(" ")).toMatch(/No image-generation provider/);
    expect(r.notes.join(" ")).toMatch(/no approved claims/);
    expect(r.creatives[0]!.versions[0]!.specs[0]!.background.kind).toBe("gradient");
  });

  it("“Make the headline larger, change the background and keep the product bottle unchanged”", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx);
    const { kit, pack } = await kitWithPackshot(ctx);
    const r = await generateCreatives(ctx, { workspaceId: "ws_carpediem", brandKitId: kit.id, productId: "prod_sleeptime", brief: "ads", count: 1, formats: ["instagram-square", "web-hero"] });
    const before = r.creatives[0]!;
    const e = await editCreative(ctx, before.id, "Make the headline larger, change the background and keep the product bottle unchanged.");
    const v1 = before.versions[0]!;
    const v2 = e.creative.versions[1]!;
    expect(e.applied.join(" ")).toMatch(/enlarged/);
    expect(e.applied.join(" ")).toMatch(/background/i);
    for (let i = 0; i < v1.specs.length; i++) {
      expect(v2.specs[i]!.headline.size).toBeGreaterThan(v1.specs[i]!.headline.size);
      expect(v2.specs[i]!.background).not.toEqual(v1.specs[i]!.background);
      expect(v2.specs[i]!.product).toEqual(v1.specs[i]!.product);
      expect(v2.specs[i]!.product?.assetId).toBe(pack.id);
    }
    expect(e.creative.versions).toHaveLength(2);
  });

  it("parses common edit instructions deterministically", () => {
    expect(parseEditInstruction('Change the headline to "Sleep, simplified" and make the background beige')).toMatchObject({ headlineText: "Sleep, simplified", backgroundColor: "#EFE6D8", keepProduct: true });
    expect(parseEditInstruction("redesign the bottle").keepProduct).toBe(false);
  });

  it("refuses to approve a version with blocking compliance issues", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx, { concepts: [{ headline: "Cures insomnia fast", subline: "Doctor recommended", cta: "Buy" }] });
    const { kit } = await kitWithPackshot(ctx);
    const r = await generateCreatives(ctx, { workspaceId: "ws_carpediem", brandKitId: kit.id, productId: "prod_sleeptime", brief: "ads", count: 1, formats: ["instagram-square"] });
    expect(r.creatives[0]!.status).toBe("needs_changes");
    await expect(setCreativeStatus(ctx, r.creatives[0]!.id, "approved")).rejects.toThrow(/compliance/);
  });
});
