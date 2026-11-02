import type { Ctx } from "@/core/context";
import { newId } from "@/core/util";

export interface Asset {
  id: string;
  workspaceId: string;
  name: string;
  mime: string;
  b64: string;
  width?: number;
  height?: number;
  kind: "logo" | "packshot" | "photo" | "background" | "reference" | "generated" | "report" | "other";
  approved: boolean;
  source: "upload" | "ai" | "bingo";
  provider?: string;
  createdAt: string;
}

export interface Claim {
  id: string;
  text: string;
  evidenceRef?: string;
  markets?: string[]; // ISO country codes where it may be used; empty = all
  approvedBy?: string;
  approvedAt?: string;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  description: string; // approved description; empty until provided
  approvedClaims: Claim[];
  /** Approved facts that may be repeated verbatim (pack size, format, ingredients…). */
  facts: string[];
  packshotAssetIds: string[];
  photoAssetIds: string[];
  disclaimer: string;
  url?: string;
  markets?: string[];
}

export interface BrandKit {
  id: string;
  workspaceId: string;
  name: string;
  verified: boolean; // owner confirmed the kit reflects official guidelines
  logoAssetId?: string;
  colors: { primary: string; secondary: string; accent: string; background: string; text: string; muted: string };
  fonts: { heading: string; body: string };
  tone: string[];
  visualGuidelines: string;
  targetAudience: string;
  regulatoryConstraints: string[];
  forbiddenPhrases: string[];
  companyFacts: string[]; // approved facts about the company (for outreach and websites)
  products: Product[];
  updatedAt: string;
}

/**
 * Starter kit for Carpediem. Only the brand direction (premium, clean,
 * science-led) is pre-filled. Colours are a neutral draft and NO product
 * claims or descriptions are invented: BINGO will refuse to state product
 * benefits until approved claims are added here.
 */
export function carpediemStarterKit(now: string): BrandKit {
  return {
    id: "brand_carpediem",
    workspaceId: "ws_carpediem",
    name: "Carpediem",
    verified: false,
    colors: { primary: "#0F2A3D", secondary: "#E9EEF2", accent: "#2FA39A", background: "#FAFBFC", text: "#0B1620", muted: "#5B6B78" },
    fonts: { heading: "Fraunces", body: "Inter" },
    tone: ["premium", "clean", "science-led", "calm", "trustworthy"],
    visualGuidelines:
      "Generous white space, soft natural light, precise typography, restrained palette with one accent colour. Product packshots shown exactly as supplied. No clutter, no cartoon styles, no exaggerated medical imagery.",
    targetAudience: "",
    regulatoryConstraints: [
      "Nutraceutical / wellness products: no claims to diagnose, treat, cure or prevent disease.",
      "Only use claims listed as approved for the product and market.",
      "No testimonials, certifications or study results unless approved with evidence.",
    ],
    forbiddenPhrases: ["cure", "cures", "treats", "heals", "miracle", "guaranteed results", "no side effects", "FDA approved", "doctor recommended", "clinically proven"],
    companyFacts: [],
    products: [
      { id: "prod_sleeptime", name: "SleepTime", category: "", description: "", approvedClaims: [], facts: [], packshotAssetIds: [], photoAssetIds: [], disclaimer: "" },
      { id: "prod_happygut140b", name: "HappyGut 140B", category: "", description: "", approvedClaims: [], facts: [], packshotAssetIds: [], photoAssetIds: [], disclaimer: "" },
    ],
    updatedAt: now,
  };
}

export async function listBrandKits(ctx: Ctx): Promise<BrandKit[]> {
  const kits = await ctx.store.list<BrandKit>("brand_kits", { newestFirst: false });
  if (kits.length) return kits;
  const starter = carpediemStarterKit(ctx.now().toISOString());
  await ctx.store.put("brand_kits", starter);
  return [starter];
}

export async function getBrandKit(ctx: Ctx, id: string) {
  await listBrandKits(ctx);
  return ctx.store.get<BrandKit>("brand_kits", id);
}

export async function brandKitForWorkspace(ctx: Ctx, workspaceId: string) {
  const kits = await listBrandKits(ctx);
  return kits.find((k) => k.workspaceId === workspaceId) ?? null;
}

export async function saveBrandKit(ctx: Ctx, kit: BrandKit) {
  const clean: BrandKit = { ...kit, updatedAt: ctx.now().toISOString() };
  for (const c of Object.values(clean.colors)) if (!/^#[0-9a-f]{6}$/i.test(c)) throw new Error(`Colour ${c} must be a #RRGGBB hex value`);
  await ctx.store.put("brand_kits", clean);
  return clean;
}

export function findProduct(kit: BrandKit, text: string): Product | null {
  const t = text.toLowerCase();
  return [...kit.products].sort((a, b) => b.name.length - a.name.length).find((p) => t.includes(p.name.toLowerCase())) ?? null;
}

export async function saveAsset(ctx: Ctx, a: Omit<Asset, "id" | "createdAt"> & { id?: string }): Promise<Asset> {
  const rec: Asset = { ...a, id: a.id ?? newId("ast"), createdAt: ctx.now().toISOString() };
  await ctx.store.put("assets", rec);
  return rec;
}

export async function getAsset(ctx: Ctx, id: string) {
  return ctx.store.get<Asset>("assets", id);
}

/** Approved, factual context for prompts. Contains nothing that is not in the kit. */
export function brandContext(kit: BrandKit, product: Product | null, market?: string): string {
  const claims = product?.approvedClaims.filter((c) => !c.markets?.length || !market || c.markets.includes(market)) ?? [];
  return [
    `Brand: ${kit.name}. Tone: ${kit.tone.join(", ")}.`,
    kit.visualGuidelines && `Visual guidelines: ${kit.visualGuidelines}`,
    kit.targetAudience && `Target audience: ${kit.targetAudience}`,
    kit.companyFacts.length ? `Approved company facts:\n- ${kit.companyFacts.join("\n- ")}` : "No approved company facts recorded.",
    product ? `Product: ${product.name}${product.category ? ` (${product.category})` : ""}.` : "",
    product?.description ? `Approved description: ${product.description}` : product ? "No approved product description yet." : "",
    product?.facts.length ? `Approved product facts:\n- ${product.facts.join("\n- ")}` : "",
    claims.length ? `APPROVED CLAIMS (the only benefit statements you may use, verbatim or lightly shortened):\n${claims.map((c) => `- [${c.id}] ${c.text}`).join("\n")}` : "There are NO approved claims: do not state any health, efficacy or performance benefit.",
    `Regulatory constraints:\n- ${kit.regulatoryConstraints.join("\n- ")}`,
    `Never use: ${kit.forbiddenPhrases.join(", ")}. Never invent packaging, certifications, studies, statistics, prices or testimonials.`,
  ]
    .filter(Boolean)
    .join("\n");
}
