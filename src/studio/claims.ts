import type { BrandKit, Product } from "./brand";

/**
 * Deterministic compliance check for marketing copy against approved claims.
 * Runs on every creative, landing page and outreach email before it can be
 * approved or published. It is intentionally strict: anything that looks like
 * a benefit, number, certification or testimonial must trace back to the kit.
 */
export interface ComplianceIssue {
  severity: "block" | "review";
  text: string;
  reason: string;
}

export interface ComplianceResult {
  status: "pass" | "needs_review" | "blocked";
  issues: ComplianceIssue[];
  matchedClaims: string[];
}

const CLAIM_TRIGGERS =
  /\b(help(s|ing)?|support(s|ing)?|improv(e|es|ing)|boost(s|ing)?|reduc(e|es|ing)|promot(e|es|ing)|relie(f|ve|ves)|restor(e|es)|enhanc(e|es)|strengthen(s)?|balanc(e|es)|aid(s)?|maintain(s)?|protect(s)?|fight(s)?|prevent(s)?|clinically|proven|scientifically|studies|study|research shows|doctor|recommended|certified|approved|guarantee|#1|number one|best|only|100%|deeper|faster|better sleep|immunity|digestion|gut health)\b/i;

const MEDICAL = /\b(cure[sd]?|treat(s|ment|ed)?|heal(s|ing)?|diagnos\w*|prevent(s)? (disease|illness|cancer|diabetes|infection)|insomnia|disorder|disease|therapy)\b/i;
const TESTIMONIAL = /(["“«].{10,}["”»]\s*[—–-]\s*\p{Lu})|(\b(customer|user|patient) (says|said|review)\b)|★{3,}/iu;
const CERT = /\b(FDA|GMP|WHO|ISO\s?\d*|HACCP|FSSAI|CDSCO|halal|kosher|organic|vegan|certified|approved by)\b/i;
const NUMBERS = /\d+(?:[.,]\d+)?\s?(?:%|billion|bn|million|mg|mcg|g|cfu|x|times|hours?|minutes?)?/gi;
const PRICE = /([$€£₹₽]|\b(usd|eur|inr|rub|uzs|price|cost|discount|off)\b)\s?\d|\d+\s?([$€£₹₽]|usd|eur|inr|rub)/i;

function tokens(s: string) {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

export function similarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkCompliance(copy: string, kit: BrandKit, product: Product | null, opts: { market?: string; allowPrices?: boolean } = {}): ComplianceResult {
  const issues: ComplianceIssue[] = [];
  const matched = new Set<string>();
  const claims = (product?.approvedClaims ?? []).filter((c) => !c.markets?.length || !opts.market || c.markets.includes(opts.market));
  const approvedText = [...claims.map((c) => c.text), ...(product?.facts ?? []), ...kit.companyFacts, product?.description ?? "", product?.name ?? "", kit.name].join(" \n ");

  for (const phrase of kit.forbiddenPhrases) {
    const re = new RegExp(`(^|[^\\p{L}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "iu");
    if (re.test(copy) && !claims.some((c) => re.test(c.text))) issues.push({ severity: "block", text: phrase, reason: "Forbidden phrase for this brand" });
  }

  for (const s of sentences(copy)) {
    const best = claims.map((c) => ({ c, score: similarity(s, c.text) })).sort((a, b) => b.score - a.score)[0];
    const covered = best && best.score >= 0.6;
    if (covered) matched.add(best!.c.id);
    if (MEDICAL.test(s) && !covered) issues.push({ severity: "block", text: s, reason: "Medical/disease claim not in approved claims" });
    else if (TESTIMONIAL.test(s)) issues.push({ severity: "block", text: s, reason: "Testimonials are not allowed unless approved with evidence" });
    else if (CERT.test(s) && !covered && !new RegExp(CERT.source, "i").test(approvedText)) issues.push({ severity: "block", text: s, reason: "Certification/approval mention is not in the brand kit" });
    else if (CLAIM_TRIGGERS.test(s) && !covered) issues.push({ severity: "review", text: s, reason: claims.length ? "Benefit-style statement that does not match an approved claim" : "No approved claims exist for this product yet" });

    if (!opts.allowPrices && PRICE.test(s)) issues.push({ severity: "block", text: s, reason: "Prices or discounts must come from approved commercial terms" });
    for (const n of s.match(NUMBERS) ?? []) {
      const digits = n.replace(/\s/g, "");
      if (digits.length && /\d/.test(digits) && !approvedText.replace(/\s/g, "").toLowerCase().includes(digits.toLowerCase())) {
        issues.push({ severity: "review", text: n.trim(), reason: `Number "${n.trim()}" is not in approved facts or claims` });
      }
    }
  }
  const status = issues.some((i) => i.severity === "block") ? "blocked" : issues.length ? "needs_review" : "pass";
  return { status, issues, matchedClaims: [...matched] };
}
