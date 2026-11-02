import { z } from "zod";
import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { callJson, callResearch } from "@/ai/engine";
import { errorMessage, normalizeCompanyName, normalizeDomain } from "@/core/util";
import { UNTRUSTED_SYSTEM_RULES, isSafePublicUrl, wrapUntrusted } from "@/security/untrusted";
import { brandKitForWorkspace } from "@/studio/brand";
import { COUNTRY_LANGUAGE, COUNTRY_TIMEZONE, countryName, findDuplicate, newLead, saveLead, syncLeadsToSheet, type Lead } from "./crm";

/**
 * Verified distributor research:
 * web research with sources → structured extraction (only what the sources
 * say) → de-duplication → website verification by fetching the official site
 * → relevance scoring → CRM + Google Sheets + knowledge graph.
 */
const CandidatesSchema = z.object({
  candidates: z.array(
    z.object({
      company: z.string(),
      website: z.string(),
      city: z.string(),
      description: z.string(),
      portfolio: z.string(),
      emails: z.array(z.string()),
      phones: z.array(z.string()),
      sourceUrls: z.array(z.string()),
    }),
  ),
});

const ScoreSchema = z.object({ relevance: z.number(), portfolioFit: z.string(), risks: z.string() });

export interface ResearchInput {
  workspaceId: string;
  country: string; // ISO2
  count: number;
  segment: string; // e.g. "pharmaceutical and nutraceutical distributors"
}

export interface ResearchResult {
  created: Lead[];
  duplicates: { company: string; existingId: string }[];
  rejected: { company: string; reason: string }[];
  sources: number;
  notes: string[];
}

export async function researchDistributors(ctx: Ctx, input: ResearchInput, actor = "bingo"): Promise<ResearchResult> {
  const country = countryName(input.country);
  const kit = await brandKitForWorkspace(ctx, input.workspaceId);
  const portfolio = kit ? `${kit.name}: ${kit.products.map((p) => p.name).join(", ")}${kit.products.some((p) => p.category) ? ` (${kit.products.map((p) => p.category).filter(Boolean).join(", ")})` : ""}` : "";
  const research = await callResearch(
    ctx,
    `Find up to ${input.count} real, currently operating ${input.segment} in ${country}. For each: official company name, official website, city, what they distribute (therapeutic areas / categories, brands carried), and any official business contact email or phone shown on their own website. Prefer importers/distributors with nationwide pharmacy or wholesale coverage. Our portfolio for context: ${portfolio || "nutraceutical / wellness products"}. Give the source URL for each company.`,
    { workspaceId: input.workspaceId, purpose: "global.research", maxUses: Math.min(20, 4 + input.count) },
  );
  const notes: string[] = [];
  if (!research.sources.length) notes.push("The research provider returned no sources; nothing was saved because BINGO only stores companies backed by sources.");

  const { data } = await callJson(
    ctx,
    {
      capability: "classification",
      system: `Extract company records from research notes. Include ONLY companies that appear in the notes with a website or source URL. Copy emails/phones exactly as written; never guess them. ${UNTRUSTED_SYSTEM_RULES}`,
      prompt: `${wrapUntrusted("web-research", research.text).block}\n\nKnown source URLs:\n${research.sources.map((s) => s.url).join("\n")}`,
    },
    CandidatesSchema,
    { workspaceId: input.workspaceId, purpose: "global.extract" },
  );

  const out: ResearchResult = { created: [], duplicates: [], rejected: [], sources: research.sources.length, notes };
  const sourceSet = new Set(research.sources.map((s) => s.url));
  for (const c of data.candidates.slice(0, input.count)) {
    if (!c.company.trim() || (!c.website && !c.sourceUrls.length)) {
      out.rejected.push({ company: c.company || "(unnamed)", reason: "No website or source" });
      continue;
    }
    // Only keep companies whose cited sources really came from the research run.
    const cited = c.sourceUrls.filter((u) => sourceSet.has(u) || [...sourceSet].some((s) => normalizeDomain(s) === normalizeDomain(u)));
    if (!cited.length && !research.sources.some((s) => normalizeDomain(s.url) === normalizeDomain(c.website))) {
      out.rejected.push({ company: c.company, reason: "Not backed by a research source" });
      continue;
    }
    const dup = await findDuplicate(ctx, { company: c.company, country: input.country, website: c.website, emails: c.emails.map((address) => ({ address })) }, input.workspaceId);
    if (dup) {
      out.duplicates.push({ company: c.company, existingId: dup.id });
      continue;
    }
    let lead = newLead(ctx, {
      workspaceId: input.workspaceId,
      company: c.company.trim(),
      country: input.country,
      city: c.city,
      website: c.website,
      description: c.description,
      segment: input.segment,
      emails: c.emails.filter((e) => /@/.test(e)).map((address) => ({ address: address.trim(), source: "research", verified: false })),
      phones: c.phones,
      sources: research.sources.filter((s) => cited.includes(s.url) || normalizeDomain(s.url) === normalizeDomain(c.website)),
      language: COUNTRY_LANGUAGE[input.country] ?? null,
      languageSource: COUNTRY_LANGUAGE[input.country] ? "country" : null,
      timezone: COUNTRY_TIMEZONE[input.country] ?? null,
      origin: "research",
    });
    lead = await verifyLead(ctx, lead);
    if (lead.verification.status === "verified") {
      lead.stage = "Verified";
      lead.stageHistory.push({ stage: "Verified", at: ctx.now().toISOString(), by: "bingo", note: "official website checked" });
    }
    try {
      const { data: score } = await callJson(
        ctx,
        {
          capability: "classification",
          system: `Score how relevant a potential distributor is for the portfolio, 0-100. Be conservative. ${UNTRUSTED_SYSTEM_RULES}`,
          prompt: `Portfolio: ${portfolio}\nSegment wanted: ${input.segment}\n${wrapUntrusted("company-profile", `${lead.company}\n${lead.description}\n${c.portfolio}`).block}`,
        },
        ScoreSchema,
        { workspaceId: input.workspaceId, purpose: "global.score", priority: "economy" },
      );
      lead.relevance = Math.max(0, Math.min(100, Math.round(score.relevance)));
      lead.portfolioFit = [score.portfolioFit, score.risks && `Risks: ${score.risks}`].filter(Boolean).join(" ");
    } catch (e) {
      lead.portfolioFit = `Scoring unavailable: ${errorMessage(e)}`;
    }
    await saveLead(ctx, lead);
    out.created.push(lead);
  }
  const sync = await syncLeadsToSheet(ctx, out.created);
  if (sync.status !== "ok") notes.push(`Google Sheet: ${(sync as { message?: string }).message ?? sync.status}`);
  await logActivity(ctx, {
    actor,
    action: "global.research",
    summary: `Researched ${country}: ${out.created.length} new leads (${out.created.filter((l) => l.verification.status === "verified").length} verified), ${out.duplicates.length} duplicates skipped, ${out.rejected.length} rejected`,
    level: "success",
    workspaceId: input.workspaceId,
  });
  return out;
}

/** Fetches the official website and checks name and contact details against it. */
export async function verifyLead(ctx: Ctx, lead: Lead): Promise<Lead> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  let pageText = "";
  const url = lead.website ? (/^https?:\/\//.test(lead.website) ? lead.website : `https://${lead.website}`) : "";
  if (url && !isSafePublicUrl(url)) checks.push({ name: "website reachable", ok: false, detail: "Website address is not a public http(s) URL" });
  else if (url) {
    for (const path of ["", "/contact", "/contacts", "/kontakty", "/contact-us"]) {
      try {
        const res = await ctx.fetch(new URL(path || "/", url).toString(), { redirect: "follow", signal: AbortSignal.timeout(12_000), headers: { "user-agent": "BINGO-verifier/1.0 (+business research)" } });
        if (res.ok) {
          const html = await res.text();
          pageText += ` ${html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")}`;
          if (!path) checks.push({ name: "website reachable", ok: true, detail: `HTTP ${res.status}` });
        } else if (!path) checks.push({ name: "website reachable", ok: false, detail: `HTTP ${res.status}` });
      } catch (e) {
        if (!path) checks.push({ name: "website reachable", ok: false, detail: errorMessage(e) });
      }
      if (pageText.length > 200_000) break;
    }
  } else checks.push({ name: "website reachable", ok: false, detail: "No website" });

  const lower = pageText.toLowerCase();
  const nameTokens = normalizeCompanyName(lead.company).split(" ").filter((t) => t.length > 2);
  const hits = nameTokens.filter((t) => lower.includes(t)).length;
  const domainMatch = nameTokens.some((t) => lead.domain.includes(t.replace(/[^a-z0-9]/g, "")));
  const nameOk = nameTokens.length > 0 && (hits / nameTokens.length >= 0.5 || domainMatch);
  checks.push({ name: "company name on website", ok: nameOk, detail: `${hits}/${nameTokens.length} name words found${domainMatch ? ", domain matches name" : ""}` });

  const emails = lead.emails.map((e) => {
    const onSite = lower.includes(e.address.toLowerCase());
    const sameDomain = normalizeDomain(e.address) === lead.domain;
    return { ...e, verified: onSite, note: onSite ? "listed on official website" : sameDomain ? "company domain, not listed on site" : "not found on official website" };
  });
  // Emails published on the website that research missed.
  for (const m of new Set(lower.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [])) {
    if (normalizeDomain(m) === lead.domain && !emails.some((e) => e.address.toLowerCase() === m)) emails.push({ address: m, source: "website", verified: true, note: "found on official website" });
  }
  checks.push({ name: "contact email published", ok: emails.some((e) => e.verified), detail: emails.filter((e) => e.verified).map((e) => e.address).join(", ") || "none found" });
  const reachable = checks[0]?.ok ?? false;
  const status = reachable && nameOk ? "verified" : reachable ? "unverified" : "failed";
  return { ...lead, emails, verification: { status, checks, at: ctx.now().toISOString() } };
}
