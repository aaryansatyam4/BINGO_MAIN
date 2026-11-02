import type { Ctx } from "@/core/context";
import { callTranslate, discoverLanguages } from "@/ai/engine";
import { detectLanguage, isRtl, languageName, scriptOf, type Detection } from "./detect";

/**
 * Multilingual Intelligence Layer.
 * - Protects names, numbers, emails, URLs and glossary terms with placeholders.
 * - Verifies every placeholder survived translation.
 * - Flags high-impact (pharma / regulatory / contract) text for human review.
 * - Always keeps the original next to the translation.
 */

export const HIGH_IMPACT_TERMS = [
  // English
  "registration", "registered", "license", "licence", "dossier", "gmp", "who-gmp", "fda", "cdsco", "certificate", "certification", "exclusive", "exclusivity",
  "contract", "agreement", "liability", "indemn", "warranty", "penalty", "dosage", "dose", "contraindication", "side effect", "adverse", "clinical", "efficacy",
  "prescription", "regulatory", "tender", "payment terms", "incoterms", "letter of credit", "minimum order", "moq",
  // Russian / Central Asian business terms
  "регистрац", "лиценз", "сертификат", "эксклюзив", "договор", "контракт", "дозировк", "противопоказ", "побочн", "клиническ", "предоплат", "тендер",
  // Hindi
  "पंजीकरण", "लाइसेंस", "अनुबंध", "खुराक",
];

export interface Glossary {
  /** Terms that must never be translated (brand & product names, people). */
  keep: string[];
}

export interface Protected {
  text: string;
  tokens: string[];
}

const PATTERNS: RegExp[] = [
  /\bhttps?:\/\/[^\s<>"')]+/giu,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu,
  /\+?\d[\d\s().-]{6,}\d/gu, // phone numbers
  /\b\d+(?:[.,]\d+)*\s?(?:%|mg|mcg|g|kg|ml|l|cfu|iu|usd|inr|eur|rub|uzs|billion|b|m|k)?\b/giu,
  /\b[A-Z]{2,}[-\d]*[A-Z\d]*\b/gu, // acronyms / codes (GMP, ISO-9001, T-0042)
];

/** Applies a replacement only to text outside existing ⟦n⟧ placeholders. */
function replaceOutside(text: string, re: RegExp, fn: (m: string) => string): string {
  return text
    .split(/(⟦\d+⟧)/u)
    .map((seg) => (/^⟦\d+⟧$/u.test(seg) ? seg : seg.replace(re, fn)))
    .join("");
}

export function protect(text: string, glossary: Glossary = { keep: [] }): Protected {
  const tokens: string[] = [];
  let out = text;
  const add = (m: string) => (m.trim() ? `⟦${tokens.push(m) - 1}⟧` : m);
  const keep = [...glossary.keep].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const term of keep) out = replaceOutside(out, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu"), add);
  for (const re of PATTERNS) out = replaceOutside(out, re, add);
  return { text: out, tokens };
}

export function restore(text: string, tokens: string[]): { text: string; missing: string[] } {
  const seen = new Set<number>();
  const out = text.replace(/⟦\s*(\d+)\s*⟧/g, (_m, n) => {
    const i = Number(n);
    seen.add(i);
    return tokens[i] ?? "";
  });
  const missing = tokens.filter((_t, i) => !seen.has(i));
  return { text: out, missing };
}

export function highImpactTermsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return HIGH_IMPACT_TERMS.filter((t) => lower.includes(t));
}

export interface TranslationRecord {
  original: string;
  translated: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
  model: string;
  needsReview: boolean;
  reviewReasons: string[];
  detection: Detection;
  rtl: boolean;
}

export async function translateText(
  ctx: Ctx,
  text: string,
  target: string,
  opts: { source?: string; glossary?: Glossary; workspaceId?: string; purpose?: string } = {},
): Promise<TranslationRecord> {
  const detection = detectLanguage(text);
  const source = opts.source ?? (detection.language !== "und" ? detection.language : undefined);
  const reasons: string[] = [];
  if (source && source.split("-")[0] === target.split("-")[0]) {
    return { original: text, translated: text, sourceLanguage: source, targetLanguage: target, provider: "none", model: "none", needsReview: false, reviewReasons: [], detection, rtl: isRtl(target) };
  }
  if (detection.confidence < 0.5) reasons.push(`Source language uncertain (${Math.round(detection.confidence * 100)}% confident it is ${languageName(detection.language)})`);

  const paragraphs = text.split(/\n{2,}/);
  const prot = paragraphs.map((p) => protect(p, opts.glossary));
  const res = await callTranslate(ctx, { texts: prot.map((p) => p.text), target, source }, { purpose: opts.purpose ?? "translation", workspaceId: opts.workspaceId });
  const restored = res.texts.map((t, i) => restore(t, prot[i]!.tokens));
  const missing = restored.flatMap((r) => r.missing);
  if (missing.length) reasons.push(`Protected values changed or dropped: ${missing.slice(0, 5).join(", ")}`);
  const impact = highImpactTermsIn(text);
  if (impact.length) reasons.push(`Contains high-impact terms (${impact.slice(0, 4).join(", ")}) — verify wording before sending`);
  return {
    original: text,
    translated: restored.map((r) => r.text).join("\n\n"),
    sourceLanguage: res.detectedSource ?? source ?? "und",
    targetLanguage: target,
    provider: res.provider,
    model: res.modelId,
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
    detection,
    rtl: isRtl(target),
  };
}

// ---------------------------------------------------------------------------
// Language registry (discovered from providers, not hard-coded)
// ---------------------------------------------------------------------------

export interface LanguageEntry {
  id: string; // BCP-47
  name: string;
  script: string;
  rtl: boolean;
  text: string[]; // providers that translate it
  tts: string[];
  stt: string[];
  verified: boolean; // owner marked quality as verified
  notes?: string;
}

export async function refreshLanguageRegistry(ctx: Ctx): Promise<LanguageEntry[]> {
  const found = await discoverLanguages(ctx);
  const map = new Map<string, LanguageEntry>();
  for (const existing of await ctx.store.list<LanguageEntry>("languages")) map.set(existing.id, { ...existing, text: [] });
  for (const { provider, languages } of found) {
    for (const l of languages) {
      const id = l.code;
      const cur: LanguageEntry = map.get(id) ?? { id, name: l.name ?? languageName(id), script: scriptOf(id), rtl: isRtl(id), text: [], tts: [], stt: [], verified: false };
      if (l.text && !cur.text.includes(provider)) cur.text.push(provider);
      if (l.tts && !cur.tts.includes(provider)) cur.tts.push(provider);
      if (l.stt && !cur.stt.includes(provider)) cur.stt.push(provider);
      map.set(id, cur);
    }
  }
  for (const e of map.values()) await ctx.store.put("languages", e);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listLanguages(ctx: Ctx) {
  return (await ctx.store.list<LanguageEntry>("languages")).sort((a, b) => a.name.localeCompare(b.name));
}

/** Records telephony/voice support declared by a connected voice provider. */
export async function declareVoiceSupport(ctx: Ctx, provider: string, langs: { code: string; tts: boolean; stt: boolean }[]) {
  for (const l of langs) {
    const cur: LanguageEntry = (await ctx.store.get<LanguageEntry>("languages", l.code)) ?? { id: l.code, name: languageName(l.code), script: scriptOf(l.code), rtl: isRtl(l.code), text: [], tts: [], stt: [], verified: false };
    if (l.tts && !cur.tts.includes(provider)) cur.tts.push(provider);
    if (l.stt && !cur.stt.includes(provider)) cur.stt.push(provider);
    await ctx.store.put("languages", cur);
  }
}

/** Honest answer to "can BINGO speak/write this language?" */
export async function languageSupport(ctx: Ctx, code: string): Promise<{ text: boolean; voiceOut: boolean; voiceIn: boolean; message: string }> {
  const base = code.split("-")[0]!;
  const all = await listLanguages(ctx);
  const e = all.find((l) => l.id === code) ?? all.find((l) => l.id.split("-")[0] === base);
  const name = languageName(code);
  if (!e) return { text: false, voiceOut: false, voiceIn: false, message: `${name}: no connected provider has reported support yet. Text can still be attempted by a multilingual LLM, but it will be marked for human review.` };
  const parts = [
    e.text.length ? `writing via ${e.text.join(", ")}` : "no dedicated translation provider",
    e.tts.length ? `speaking via ${e.tts.join(", ")}` : "no reliable synthetic voice",
    e.stt.length ? `listening via ${e.stt.join(", ")}` : "no reliable speech recognition",
  ];
  return { text: e.text.length > 0, voiceOut: e.tts.length > 0, voiceIn: e.stt.length > 0, message: `${name}: ${parts.join("; ")}.${e.verified ? " Quality verified by you." : " Quality not yet verified."}` };
}
