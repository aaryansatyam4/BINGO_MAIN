import { z } from "zod";
import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { callImage, callJson, route } from "@/ai/engine";
import { errorMessage, newId } from "@/core/util";
import { pushToSheet } from "@/integrations/sheets-sync";
import { brandContext, getAsset, getBrandKit, saveAsset, type Asset, type BrandKit, type Product } from "./brand";
import { checkCompliance, type ComplianceResult } from "./claims";
import { FORMATS, checkReadability, ensureReadable, layoutCreative, reflowText, renderSvg, type CopyBlock, type CreativeSpec, type ReadabilityReport } from "./compose";

/**
 * BINGO STUDIO creative pipeline:
 * brief → approved brand context → concepts & copy (LLM, constrained to approved
 * claims) → compliance check → background generation (image provider, if
 * connected) → layered composition in every requested format → readability
 * checks → versioned creative awaiting the owner's approval.
 */
export interface CreativeVersion {
  v: number;
  createdAt: string;
  note: string;
  specs: CreativeSpec[];
  copy: CopyBlock;
  compliance: ComplianceResult;
  readability: { format: string; report: ReadabilityReport }[];
}

export interface Creative {
  id: string;
  workspaceId: string;
  brandKitId: string;
  productId: string | null;
  brief: string;
  concept: { name: string; angle: string; imagePrompt: string };
  status: "in_review" | "needs_changes" | "approved" | "rejected" | "published";
  versions: CreativeVersion[];
  notes: string[];
  createdAt: string;
  approvedAt?: string;
}

const ConceptSchema = z.object({
  concepts: z.array(
    z.object({
      name: z.string(),
      angle: z.string(),
      headline: z.string(),
      subline: z.string(),
      cta: z.string(),
      imagePrompt: z.string().describe("Background/scene only. No text, no product, no logos, no people's faces unless asked."),
      claimIds: z.array(z.string()),
    }),
  ),
});

export interface GenerateCreativesInput {
  workspaceId: string;
  brandKitId: string;
  productId?: string | null;
  brief: string;
  count: number;
  formats: string[];
  styleReferences?: string;
  language?: string;
  market?: string;
}

export async function generateCreatives(ctx: Ctx, input: GenerateCreativesInput, actor = "owner"): Promise<{ creatives: Creative[]; notes: string[] }> {
  const kit = await getBrandKit(ctx, input.brandKitId);
  if (!kit) throw new Error("Brand kit not found");
  const product = input.productId ? (kit.products.find((p) => p.id === input.productId) ?? null) : null;
  const formats = input.formats.filter((f) => FORMATS[f]);
  if (!formats.length) throw new Error("Choose at least one valid format");
  const notes: string[] = [];
  if (!kit.verified) notes.push("Brand kit is not marked verified — confirm colours, fonts and logo in Studio → Brand kits.");
  if (product && !product.approvedClaims.length) notes.push(`${product.name} has no approved claims yet, so creatives avoid benefit statements. Add approved claims to unlock stronger copy.`);
  if (product && !product.packshotAssetIds.length) notes.push(`No approved packshot for ${product.name}; creatives are composed without a product image (BINGO never invents packaging).`);

  const { data } = await callJson(
    ctx,
    {
      capability: "copywriting",
      system: `You are BINGO STUDIO, a senior creative director and copywriter. You write premium, specific, non-generic copy. You must follow the brand context strictly.\n\n${brandContext(kit, product, input.market)}`,
      prompt: [
        `Brief: ${input.brief}`,
        `Create ${input.count} distinct creative concepts.`,
        input.language ? `Write all copy in ${input.language}.` : "",
        input.styleReferences ? `Style references from the owner: ${input.styleReferences}` : "",
        "Headline ≤ 8 words. Subline ≤ 18 words. CTA ≤ 3 words.",
        "claimIds must list every approved claim id you used (empty if none). Do not use any benefit that is not an approved claim.",
        "imagePrompt describes a premium photographic background scene in the brand's visual style with clear empty space for the product and text. No text in the image.",
      ]
        .filter(Boolean)
        .join("\n"),
      effort: "high",
    },
    ConceptSchema,
    { purpose: "studio.concepts", workspaceId: input.workspaceId },
  );

  const canImage = (await route(ctx, "image.generate", { workspaceId: input.workspaceId })).length > 0;
  if (!canImage) notes.push("No image-generation provider is connected, so backgrounds use the brand gradient. Connect OpenAI or Gemini in Settings → AI Models for photographic scenes.");

  const packshot = product?.packshotAssetIds[0] ? await getAsset(ctx, product.packshotAssetIds[0]) : null;
  const logo = kit.logoAssetId ? await getAsset(ctx, kit.logoAssetId) : null;
  const creatives: Creative[] = [];

  for (const c of data.concepts.slice(0, input.count)) {
    const copy: CopyBlock = { headline: c.headline, subline: c.subline, cta: c.cta, disclaimer: product?.disclaimer ?? "" };
    const compliance = checkCompliance([c.headline, c.subline, c.cta].join("\n"), kit, product, { market: input.market });
    let bgAsset: Asset | null = null;
    if (canImage) {
      try {
        bgAsset = await generateBackground(ctx, kit, c.imagePrompt, formats[0]!, input.workspaceId);
      } catch (e) {
        notes.push(`Background for "${c.name}" could not be generated (${errorMessage(e)}); used the brand gradient.`);
      }
    }
    const specs = formats.map((f) =>
      layoutCreative(kit, f, copy, {
        backgroundAssetId: bgAsset?.id,
        backgroundPrompt: c.imagePrompt,
        productAssetId: packshot?.id,
        productAspect: packshot?.width && packshot?.height ? packshot.width / packshot.height : undefined,
        logoAssetId: logo?.id,
      }),
    );
    const creative: Creative = {
      id: newId("crt"),
      workspaceId: input.workspaceId,
      brandKitId: kit.id,
      productId: product?.id ?? null,
      brief: input.brief,
      concept: { name: c.name, angle: c.angle, imagePrompt: c.imagePrompt },
      status: compliance.status === "blocked" ? "needs_changes" : "in_review",
      versions: [{ v: 1, createdAt: ctx.now().toISOString(), note: "Initial generation", specs, copy, compliance, readability: specs.map((s) => ({ format: s.format, report: checkReadability(s) })) }],
      notes: [...notes],
      createdAt: ctx.now().toISOString(),
    };
    await ctx.store.put("creatives", creative);
    creatives.push(creative);
  }
  await logActivity(ctx, { actor, action: "studio.generated", summary: `Generated ${creatives.length} creative concept(s) for ${product?.name ?? kit.name}`, level: "success", workspaceId: input.workspaceId });
  await syncCreativesToSheet(ctx, creatives, kit);
  return { creatives, notes };
}

async function generateBackground(ctx: Ctx, kit: BrandKit, prompt: string, format: string, workspaceId: string): Promise<Asset> {
  const f = FORMATS[format]!;
  const res = await callImage(
    ctx,
    {
      prompt: `${prompt}\nStyle: ${kit.tone.join(", ")}. ${kit.visualGuidelines}\nColour palette: ${Object.values(kit.colors).join(", ")}.\nAbsolutely no text, letters, logos or product packaging in the image.`,
      size: { width: f.width, height: f.height },
    },
    { purpose: "studio.background", workspaceId },
  );
  const img = res.images[0]!;
  return saveAsset(ctx, { workspaceId, name: `background-${Date.now()}.png`, mime: img.mime, b64: img.b64, kind: "background", approved: false, source: "ai", provider: `${res.provider}/${res.modelId}` });
}

export async function getCreative(ctx: Ctx, id: string) {
  return ctx.store.get<Creative>("creatives", id);
}

export async function listCreatives(ctx: Ctx, workspaceId?: string) {
  return ctx.store.list<Creative>("creatives", workspaceId ? { where: { workspaceId } } : {});
}

export async function renderCreativeSvg(ctx: Ctx, creative: Creative, format?: string, version?: number): Promise<string> {
  const v = version ? creative.versions.find((x) => x.v === version)! : creative.versions.at(-1)!;
  const spec = v.specs.find((s) => s.format === (format ?? v.specs[0]!.format)) ?? v.specs[0]!;
  const ids = [spec.background.kind === "image" ? spec.background.assetId : null, spec.product?.assetId, spec.logo?.assetId].filter(Boolean) as string[];
  const assets = new Map<string, Asset>();
  for (const id of ids) {
    const a = await getAsset(ctx, id);
    if (a) assets.set(id, a);
  }
  return renderSvg(spec, assets);
}

// ---------------------------------------------------------------------------
// Natural-language edits ("make the headline larger, change the background, keep the bottle")
// ---------------------------------------------------------------------------

export interface EditOps {
  headlineScale?: number;
  headlineText?: string;
  sublineText?: string;
  ctaText?: string;
  backgroundPrompt?: string; // new background
  backgroundColor?: string;
  productSide?: "left" | "right";
  textColor?: string;
  keepProduct: boolean;
}

const COLOR_WORDS: Record<string, string> = { white: "#FFFFFF", black: "#0B0B0B", navy: "#0F2A3D", blue: "#1F5FAD", green: "#2F7D5B", teal: "#2FA39A", beige: "#EFE6D8", cream: "#F5EFE3", grey: "#8A949E", gray: "#8A949E", gold: "#B8913A", purple: "#5B3F8C", pink: "#E7B7C8", red: "#B3261E" };

export function parseEditInstruction(text: string): EditOps {
  const t = text.toLowerCase();
  const ops: EditOps = { keepProduct: true };
  if (/headline[^.]*\b(larger|bigger|increase)/.test(t) || /\b(larger|bigger) headline/.test(t)) ops.headlineScale = /much|lot|significantly/.test(t) ? 1.35 : 1.2;
  if (/headline[^.]*\b(smaller|decrease|reduce)/.test(t) || /smaller headline/.test(t)) ops.headlineScale = 0.85;
  const quoted = (key: string) => text.match(new RegExp(`${key}[^"“'‘]*["“'‘]([^"”'’]+)["”'’]`, "i"))?.[1];
  ops.headlineText = quoted("headline") ?? undefined;
  ops.ctaText = quoted("(?:cta|button)") ?? undefined;
  ops.sublineText = quoted("(?:subline|subheading|tagline)") ?? undefined;
  const bg = t.match(/(?:change|replace|new|different|make|set)\s+(?:the\s+)?background(?:\s+(?:to|into|with|as)?\s*([^,.;]+?))?(?=\s+and\b|[,.;]|$)/);
  if (bg) {
    const want = bg[1]?.trim().replace(/^(to|into|with|as)\s+/, "") || undefined;
    const colorHit = want && Object.keys(COLOR_WORDS).find((k) => want === k || want === `${k} color` || want === `plain ${k}`);
    if (colorHit) ops.backgroundColor = COLOR_WORDS[colorHit];
    else ops.backgroundPrompt = want || "a different premium scene in the same brand style";
  }
  if (/product[^.]*\bleft\b/.test(t)) ops.productSide = "left";
  if (/product[^.]*\bright\b/.test(t)) ops.productSide = "right";
  if (/\b(change|modify|redesign)\b[^.]*\b(product|bottle|pack|packaging)\b/.test(t) && !/keep[^.]*\b(product|bottle|pack)/.test(t)) ops.keepProduct = false;
  return ops;
}

export async function editCreative(ctx: Ctx, id: string, instruction: string, actor = "owner"): Promise<{ creative: Creative; applied: string[]; refused: string[] }> {
  const creative = await getCreative(ctx, id);
  if (!creative) throw new Error("Creative not found");
  const kit = (await getBrandKit(ctx, creative.brandKitId))!;
  const product = creative.productId ? (kit.products.find((p) => p.id === creative.productId) ?? null) : null;
  const prev = creative.versions.at(-1)!;
  const ops = parseEditInstruction(instruction);
  const applied: string[] = [];
  const refused: string[] = [];
  if (!ops.keepProduct) refused.push("BINGO does not alter approved product packaging. Upload a new approved packshot to change the product image.");

  const copy = { ...prev.copy };
  if (ops.headlineText) (copy.headline = ops.headlineText), applied.push("Headline text changed");
  if (ops.sublineText) (copy.subline = ops.sublineText), applied.push("Subline changed");
  if (ops.ctaText) (copy.cta = ops.ctaText), applied.push("Button text changed");

  let newBg: CreativeSpec["background"] | null = null;
  if (ops.backgroundColor) {
    newBg = { kind: "solid", color: ops.backgroundColor };
    applied.push(`Background set to ${ops.backgroundColor}`);
  } else if (ops.backgroundPrompt) {
    try {
      const a = await generateBackground(ctx, kit, `${ops.backgroundPrompt}. Keep generous empty space for the product and text.`, prev.specs[0]!.format, creative.workspaceId);
      newBg = { kind: "image", assetId: a.id, prompt: ops.backgroundPrompt };
      applied.push("New background generated");
    } catch (e) {
      refused.push(`Background not changed: ${errorMessage(e)}`);
    }
  }

  const specs = prev.specs.map((old) => {
    let s = structuredClone(old);
    if (copy.headline !== old.headline.text || copy.subline !== (old.subline?.text ?? "") || copy.cta !== (old.cta?.text ?? "") || ops.productSide) {
      // Re-flow text with the same layout engine, then restore locked layers.
      const fresh = layoutCreative(kit, old.format, copy, {
        backgroundAssetId: old.background.kind === "image" ? old.background.assetId : undefined,
        backgroundPrompt: old.background.kind === "image" ? old.background.prompt : undefined,
        productAssetId: old.product?.assetId,
        productAspect: old.product ? old.product.w / old.product.h : undefined,
        logoAssetId: old.logo?.assetId,
        productSide: ops.productSide ?? old.productSide,
      });
      fresh.background = old.background;
      if (!ops.productSide) fresh.product = old.product; // exact same packshot geometry
      fresh.headline.size = old.headline.size;
      s = fresh;
    }
    if (newBg) s.background = newBg;
    if (ops.headlineScale) {
      s.headline.size = Math.round(s.headline.size * ops.headlineScale);
      s = reflowText(s);
    }
    s.scrim = null;
    return ensureReadable(s, kit);
  });
  if (ops.headlineScale) applied.push(`Headline ${ops.headlineScale > 1 ? "enlarged" : "reduced"} ×${ops.headlineScale}`);
  if (ops.productSide) applied.push(`Product moved to the ${ops.productSide}`);

  // Guarantee: the packshot image is byte-identical (same asset id) across versions.
  for (let i = 0; i < specs.length; i++) {
    if (prev.specs[i]?.product && specs[i]!.product?.assetId !== prev.specs[i]!.product!.assetId) throw new Error("Internal guard: product layer changed");
  }

  const compliance = checkCompliance([copy.headline, copy.subline, copy.cta].join("\n"), kit, product);
  const version: CreativeVersion = {
    v: prev.v + 1,
    createdAt: ctx.now().toISOString(),
    note: instruction,
    specs,
    copy,
    compliance,
    readability: specs.map((s) => ({ format: s.format, report: checkReadability(s) })),
  };
  const next: Creative = { ...creative, versions: [...creative.versions, version], status: compliance.status === "blocked" ? "needs_changes" : "in_review" };
  await ctx.store.put("creatives", next);
  await logActivity(ctx, { actor, action: "studio.edited", summary: `Creative "${creative.concept.name}" v${version.v}: ${applied.join(", ") || "no changes"}`, workspaceId: creative.workspaceId, ref: { kind: "creative", id } });
  return { creative: next, applied, refused };
}

export async function setCreativeStatus(ctx: Ctx, id: string, status: "approved" | "rejected", actor = "owner") {
  const c = await getCreative(ctx, id);
  if (!c) throw new Error("Creative not found");
  const latest = c.versions.at(-1)!;
  if (status === "approved" && latest.compliance.status === "blocked") throw new Error("This version has blocking compliance issues. Edit the copy first.");
  const next: Creative = { ...c, status, approvedAt: status === "approved" ? ctx.now().toISOString() : c.approvedAt };
  await ctx.store.put("creatives", next);
  await logActivity(ctx, { actor, action: `studio.${status}`, summary: `Creative "${c.concept.name}" v${latest.v} ${status}`, level: status === "approved" ? "success" : "warning", workspaceId: c.workspaceId, ref: { kind: "creative", id } });
  const kit = await getBrandKit(ctx, c.brandKitId);
  if (kit) await syncCreativesToSheet(ctx, [next], kit);
  return next;
}

async function syncCreativesToSheet(ctx: Ctx, creatives: Creative[], kit: BrandKit) {
  await pushToSheet(
    ctx,
    "creatives",
    creatives.map((c) => ({
      "BINGO ID": c.id,
      Brand: kit.name,
      Product: kit.products.find((p) => p.id === c.productId)?.name ?? "",
      Concept: c.concept.name,
      Status: c.status,
      Formats: c.versions.at(-1)!.specs.map((s) => s.format).join(", "),
      Version: c.versions.at(-1)!.v,
      Updated: ctx.now().toISOString(),
    })),
  );
}

export function productOf(kit: BrandKit, id: string | null): Product | null {
  return id ? (kit.products.find((p) => p.id === id) ?? null) : null;
}
