import { escapeHtml } from "@/core/util";
import type { Asset, BrandKit } from "./brand";

/**
 * Creative composition. AI image models are used for backgrounds/scenes only;
 * text, logo and the approved product packshot are composed as separate
 * layers, so headlines are crisp and the product image is never altered.
 */
export const FORMATS: Record<string, { width: number; height: number; label: string }> = {
  "instagram-square": { width: 1080, height: 1080, label: "Instagram post 1:1" },
  "instagram-portrait": { width: 1080, height: 1350, label: "Instagram portrait 4:5" },
  story: { width: 1080, height: 1920, label: "Story / Reel 9:16" },
  "web-hero": { width: 1920, height: 1080, label: "Website hero 16:9" },
  "ecommerce-banner": { width: 1200, height: 628, label: "Ecommerce / ad banner" },
  "email-header": { width: 1200, height: 400, label: "Email campaign header" },
  "a4-poster": { width: 2480, height: 3508, label: "A4 poster / brochure page" },
};

export interface TextLayer {
  text: string;
  size: number;
  color: string;
  weight: number;
  x: number;
  y: number;
  maxWidth: number;
  align: "start" | "middle";
  font: "heading" | "body";
}

export interface CreativeSpec {
  format: string;
  width: number;
  height: number;
  background: { kind: "image"; assetId: string; prompt: string } | { kind: "gradient"; from: string; to: string } | { kind: "solid"; color: string };
  scrim: { color: string; opacity: number; x: number; y: number; w: number; h: number; radius: number } | null;
  product: { assetId: string; x: number; y: number; w: number; h: number } | null;
  logo: { assetId: string; x: number; y: number; w: number; h: number } | null;
  headline: TextLayer;
  subline: TextLayer | null;
  cta: (TextLayer & { bg: string; padX: number; padY: number }) | null;
  disclaimer: TextLayer | null;
  fonts: { heading: string; body: string };
  locked: ("product" | "logo" | "headline" | "background")[];
  /** Layout family; kept so edits can re-flow consistently. */
  layout: "split" | "stack";
  productSide: "left" | "right";
}

export interface CopyBlock {
  headline: string;
  subline: string;
  cta: string;
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// Colour & contrast (WCAG 2.x)
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function luminance([r, g, b]: [number, number, number]) {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

function mix(top: [number, number, number], alpha: number, bottom: [number, number, number]): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round(top[i]! * alpha + bottom[i]! * (1 - alpha))) as [number, number, number];
}

/**
 * Worst-case contrast of text over its backing. For photographic backgrounds
 * the pixels are unknown, so the scrim is composited over both black and
 * white and the lower ratio is used: a guarantee, not a guess.
 */
export function worstContrast(textHex: string, spec: CreativeSpec): number {
  const text = hexToRgb(textHex);
  const backs: [number, number, number][] = [];
  if (spec.scrim) {
    const s = hexToRgb(spec.scrim.color);
    if (spec.background.kind === "image") backs.push(mix(s, spec.scrim.opacity, [0, 0, 0]), mix(s, spec.scrim.opacity, [255, 255, 255]));
    else if (spec.background.kind === "gradient") backs.push(mix(s, spec.scrim.opacity, hexToRgb(spec.background.from)), mix(s, spec.scrim.opacity, hexToRgb(spec.background.to)));
    else backs.push(mix(s, spec.scrim.opacity, hexToRgb(spec.background.color)));
  } else if (spec.background.kind === "image") {
    backs.push([0, 0, 0], [255, 255, 255]);
  } else if (spec.background.kind === "gradient") {
    backs.push(hexToRgb(spec.background.from), hexToRgb(spec.background.to));
  } else backs.push(hexToRgb(spec.background.color));
  return Math.min(...backs.map((b) => contrastRatio(text, b)));
}

// ---------------------------------------------------------------------------
// Text layout
// ---------------------------------------------------------------------------

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function charWidth(ch: string, size: number) {
  if (WIDE.test(ch)) return size;
  if (/[iljt.,:;'!|]/.test(ch)) return size * 0.3;
  if (/[MWmw@]/.test(ch)) return size * 0.85;
  if (ch === " ") return size * 0.28;
  return size * 0.56;
}

export function measure(text: string, size: number) {
  let w = 0;
  for (const ch of text) w += charWidth(ch, size);
  return w;
}

export function wrap(text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next, size) <= maxWidth || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  // Break very long single tokens (CJK has no spaces).
  return lines.flatMap((l) => {
    if (measure(l, size) <= maxWidth) return [l];
    const out: string[] = [];
    let buf = "";
    for (const ch of l) {
      if (measure(buf + ch, size) > maxWidth && buf) {
        out.push(buf);
        buf = ch;
      } else buf += ch;
    }
    if (buf) out.push(buf);
    return out;
  });
}

export function textBlockHeight(layer: TextLayer) {
  return wrap(layer.text, layer.size, layer.maxWidth).length * layer.size * 1.15;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function layoutCreative(
  kit: BrandKit,
  format: string,
  copy: CopyBlock,
  opts: { backgroundAssetId?: string; backgroundPrompt?: string; productAssetId?: string; productAspect?: number; logoAssetId?: string; productSide?: "left" | "right" } = {},
): CreativeSpec {
  const f = FORMATS[format];
  if (!f) throw new Error(`Unknown format ${format}`);
  const { width: W, height: H } = f;
  const landscape = W / H >= 0.95; // square and wider: text beside the product
  const m = Math.round(Math.min(W, H) * 0.07);
  const side = opts.productSide ?? "right";
  const scale = Math.min(W, H) / 1080;
  const c = kit.colors;
  const bg: CreativeSpec["background"] = opts.backgroundAssetId
    ? { kind: "image", assetId: opts.backgroundAssetId, prompt: opts.backgroundPrompt ?? "" }
    : { kind: "gradient", from: c.background, to: c.secondary };

  let textX: number, textW: number, textTop: number;
  let product: CreativeSpec["product"] = null;
  const aspect = opts.productAspect ?? 0.5; // width / height of packshot
  if (landscape) {
    textW = Math.round(W * 0.5) - m;
    textX = side === "right" ? m : W - m - textW;
    textTop = Math.round(H * 0.22);
    if (opts.productAssetId) {
      const ph = Math.round(H * 0.78);
      const pw = Math.round(ph * aspect);
      product = { assetId: opts.productAssetId, x: side === "right" ? W - m - pw : m, y: Math.round((H - ph) / 2), w: pw, h: ph };
    }
  } else {
    textW = W - 2 * m;
    textX = m;
    textTop = Math.round(H * 0.1);
    if (opts.productAssetId) {
      const ph = Math.round(H * 0.45);
      const pw = Math.round(ph * aspect);
      product = { assetId: opts.productAssetId, x: Math.round((W - pw) / 2), y: H - m - ph - Math.round(H * 0.06), w: pw, h: ph };
    }
  }

  const headSize = Math.round((landscape ? 64 : 78) * scale);
  const headline: TextLayer = { text: copy.headline, size: headSize, color: c.text, weight: 600, x: textX, y: textTop, maxWidth: textW, align: "start", font: "heading" };
  const hH = textBlockHeight(headline);
  const subline: TextLayer | null = copy.subline
    ? { text: copy.subline, size: Math.round(30 * scale), color: c.muted, weight: 400, x: textX, y: Math.round(textTop + hH + 24 * scale), maxWidth: textW, align: "start", font: "body" }
    : null;
  const sH = subline ? textBlockHeight(subline) : 0;
  const cta = copy.cta
    ? { text: copy.cta, size: Math.round(28 * scale), color: "#FFFFFF", weight: 600, x: textX, y: Math.round((subline ? subline.y + sH : textTop + hH) + 40 * scale), maxWidth: textW, align: "start" as const, font: "body" as const, bg: c.primary, padX: Math.round(30 * scale), padY: Math.round(18 * scale) }
    : null;
  const disclaimer: TextLayer | null = copy.disclaimer
    ? { text: copy.disclaimer, size: Math.max(14, Math.round(16 * scale)), color: c.muted, weight: 400, x: m, y: H - Math.round(m * 0.6), maxWidth: W - 2 * m, align: "start", font: "body" }
    : null;

  // Stacked layouts: shrink the packshot so it never collides with the text block.
  if (!landscape && product) {
    const textBottom = cta ? cta.y + cta.size * 1.15 + 2 * cta.padY : subline ? subline.y + sH : textTop + hH;
    const room = H - m - Math.round(H * 0.06) - (textBottom + Math.round(24 * scale));
    if (product.h > room) {
      const ph = Math.max(Math.round(H * 0.2), room);
      const pw = Math.round(ph * aspect);
      product = { ...product, h: ph, w: pw, x: Math.round((W - pw) / 2), y: H - m - ph - Math.round(H * 0.06) };
    }
  }
  const spec: CreativeSpec = {
    format,
    width: W,
    height: H,
    background: bg,
    scrim: null,
    product,
    logo: opts.logoAssetId ? { assetId: opts.logoAssetId, x: m, y: Math.round(m * 0.6), w: Math.round(180 * scale), h: Math.round(60 * scale) } : null,
    headline,
    subline,
    cta,
    disclaimer,
    fonts: kit.fonts,
    locked: ["product", "logo"],
    layout: landscape ? "split" : "stack",
    productSide: side,
  };
  return ensureReadable(spec, kit);
}

/** Adds/strengthens a scrim until text meets WCAG contrast (4.5:1 body, 3:1 large text). */
export function ensureReadable(spec: CreativeSpec, kit: BrandKit): CreativeSpec {
  const s = structuredClone(spec);
  const need = (layer: TextLayer) => (layer.size >= 24 * (s.width / 1080) * 1.5 ? 3 : 4.5);
  const layers = [s.headline, s.subline].filter(Boolean) as TextLayer[];
  const ok = () => layers.every((l) => worstContrast(l.color, s) >= need(l));
  if (ok()) return s;
  const pad = Math.round(32 * (Math.min(s.width, s.height) / 1080));
  const bottom = Math.max(...layers.map((l) => l.y + textBlockHeight(l)), s.cta ? s.cta.y + s.cta.size * 1.15 + 2 * s.cta.padY : 0);
  s.scrim = { color: kit.colors.background, opacity: 0.72, x: s.headline.x - pad, y: s.headline.y - s.headline.size - pad, w: s.headline.maxWidth + 2 * pad, h: bottom - (s.headline.y - s.headline.size) + 2 * pad, radius: pad };
  for (const o of [0.72, 0.8, 0.88, 0.95]) {
    s.scrim.opacity = o;
    if (ok()) return s;
  }
  // Fall back to the brand's dark/light pair with the highest contrast.
  for (const l of layers) l.color = contrastRatio(hexToRgb(kit.colors.text), hexToRgb(s.scrim.color)) >= 4.5 ? kit.colors.text : "#000000";
  return s;
}

export interface ReadabilityReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export function checkReadability(spec: CreativeSpec): ReadabilityReport {
  const checks: ReadabilityReport["checks"] = [];
  const scale = Math.min(spec.width, spec.height) / 1080;
  for (const [name, l] of [["headline", spec.headline], ["subline", spec.subline]] as const) {
    if (!l) continue;
    const ratio = worstContrast(l.color, spec);
    const need = l.size >= 36 * scale ? 3 : 4.5;
    checks.push({ name: `${name} contrast`, ok: ratio >= need, detail: `${ratio.toFixed(2)}:1 worst case (needs ${need}:1)` });
    checks.push({ name: `${name} size`, ok: l.size >= (name === "headline" ? 40 : 22) * scale, detail: `${l.size}px` });
    const lines = wrap(l.text, l.size, l.maxWidth).length;
    checks.push({ name: `${name} length`, ok: lines <= (name === "headline" ? 4 : 5), detail: `${lines} line(s)` });
  }
  if (spec.cta) {
    const ratio = contrastRatio(hexToRgb(spec.cta.color), hexToRgb(spec.cta.bg));
    checks.push({ name: "button contrast", ok: ratio >= 4.5, detail: `${ratio.toFixed(2)}:1` });
  }
  const bottomText = Math.max(spec.headline.y + textBlockHeight(spec.headline), spec.subline ? spec.subline.y + textBlockHeight(spec.subline) : 0);
  checks.push({ name: "fits canvas", ok: bottomText < spec.height * 0.95, detail: `text ends at ${Math.round((bottomText / spec.height) * 100)}% of height` });
  if (spec.product && spec.layout === "stack") {
    const textBottom = spec.cta ? spec.cta.y + spec.cta.size + 2 * spec.cta.padY : bottomText;
    checks.push({ name: "text clear of product", ok: textBottom < spec.product.y, detail: textBottom < spec.product.y ? "no overlap" : "text overlaps the packshot" });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

function textSvg(l: TextLayer, family: string, anchorX?: number) {
  const lines = wrap(l.text, l.size, l.maxWidth);
  const x = anchorX ?? (l.align === "middle" ? l.x + l.maxWidth / 2 : l.x);
  const tspans = lines.map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : l.size * 1.15}">${escapeHtml(line)}</tspan>`).join("");
  return `<text x="${x}" y="${l.y}" font-family="${escapeHtml(family)}, system-ui, sans-serif" font-size="${l.size}" font-weight="${l.weight}" fill="${l.color}" text-anchor="${l.align}">${tspans}</text>`;
}

export function renderSvg(spec: CreativeSpec, assets: Map<string, Pick<Asset, "mime" | "b64">>): string {
  const W = spec.width;
  const H = spec.height;
  const img = (id: string) => {
    const a = assets.get(id);
    return a ? `data:${a.mime};base64,${a.b64}` : "";
  };
  const parts: string[] = [];
  const fontsCss = [spec.fonts.heading, spec.fonts.body].map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;600`).join("&");
  parts.push(`<defs><style>@import url('https://fonts.googleapis.com/css2?${fontsCss}&amp;display=swap');</style>`);
  if (spec.background.kind === "gradient") parts.push(`<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${spec.background.from}"/><stop offset="1" stop-color="${spec.background.to}"/></linearGradient>`);
  parts.push(`</defs>`);
  if (spec.background.kind === "image") parts.push(`<image data-layer="background" href="${img(spec.background.assetId)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`);
  else if (spec.background.kind === "gradient") parts.push(`<rect data-layer="background" width="${W}" height="${H}" fill="url(#bg)"/>`);
  else parts.push(`<rect data-layer="background" width="${W}" height="${H}" fill="${spec.background.color}"/>`);
  if (spec.product) parts.push(`<image data-layer="product" href="${img(spec.product.assetId)}" x="${spec.product.x}" y="${spec.product.y}" width="${spec.product.w}" height="${spec.product.h}" preserveAspectRatio="xMidYMid meet"/>`);
  if (spec.scrim) parts.push(`<rect data-layer="scrim" x="${spec.scrim.x}" y="${spec.scrim.y}" width="${spec.scrim.w}" height="${spec.scrim.h}" rx="${spec.scrim.radius}" fill="${spec.scrim.color}" fill-opacity="${spec.scrim.opacity}"/>`);
  if (spec.logo) parts.push(`<image data-layer="logo" href="${img(spec.logo.assetId)}" x="${spec.logo.x}" y="${spec.logo.y}" width="${spec.logo.w}" height="${spec.logo.h}" preserveAspectRatio="xMinYMid meet"/>`);
  parts.push(`<g data-layer="headline">${textSvg(spec.headline, spec.fonts.heading)}</g>`);
  if (spec.subline) parts.push(`<g data-layer="subline">${textSvg(spec.subline, spec.fonts.body)}</g>`);
  if (spec.cta) {
    const w = measure(spec.cta.text, spec.cta.size) + 2 * spec.cta.padX;
    const h = spec.cta.size + 2 * spec.cta.padY;
    parts.push(
      `<g data-layer="cta"><rect x="${spec.cta.x}" y="${spec.cta.y}" width="${Math.round(w)}" height="${h}" rx="${Math.round(h / 2)}" fill="${spec.cta.bg}"/>` +
        textSvg({ ...spec.cta, y: spec.cta.y + spec.cta.padY + spec.cta.size * 0.82, maxWidth: w * 2 }, spec.fonts.body, spec.cta.x + spec.cta.padX) +
        `</g>`,
    );
  }
  if (spec.disclaimer) parts.push(`<g data-layer="disclaimer">${textSvg(spec.disclaimer, spec.fonts.body)}</g>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeHtml(spec.headline.text)}">${parts.join("")}</svg>`;
}

/** Recomputes vertical positions of subline and CTA after the headline changed size or text. */
export function reflowText(spec: CreativeSpec): CreativeSpec {
  const s = structuredClone(spec);
  const scale = Math.min(s.width, s.height) / 1080;
  let y = s.headline.y + textBlockHeight(s.headline);
  if (s.subline) {
    s.subline.y = Math.round(y + 24 * scale);
    y = s.subline.y + textBlockHeight(s.subline);
  }
  if (s.cta) s.cta.y = Math.round(y + 40 * scale);
  return s;
}
