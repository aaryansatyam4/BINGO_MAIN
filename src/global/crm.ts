import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { link, upsertNode } from "@/core/graph";
import { newId, normalizeCompanyName, normalizeDomain } from "@/core/util";
import { pullFromSheet, pushToSheet } from "@/integrations/sheets-sync";

export const STAGES = [
  "Researching",
  "Verified",
  "Qualified",
  "Outreach Approved",
  "Contacted",
  "Replied",
  "Meeting Proposed",
  "Meeting Confirmed",
  "Negotiation",
  "Proposal",
  "Agreement",
  "Active",
] as const;
export const TERMINAL = ["Not Interested", "Opted Out", "Disqualified"] as const;
export type Stage = (typeof STAGES)[number] | (typeof TERMINAL)[number];

export interface LeadEmail {
  address: string;
  source: "website" | "research" | "reply" | "form" | "manual";
  verified: boolean;
  note?: string;
}

export interface Lead {
  id: string;
  workspaceId: string;
  company: string;
  normalizedName: string;
  domain: string;
  country: string; // ISO 3166-1 alpha-2
  city: string;
  website: string;
  emails: LeadEmail[];
  phones: string[];
  contacts: { name: string; role: string; email: string }[];
  description: string;
  portfolioFit: string;
  relevance: number; // 0..100
  language: string | null;
  languageSource: "country" | "detected" | "manual" | "preference" | null;
  timezone: string | null;
  segment: string;
  stage: Stage;
  stageHistory: { stage: Stage; at: string; by: string; note?: string }[];
  sources: { url: string; title: string }[];
  verification: { status: "unverified" | "verified" | "failed"; checks: { name: string; ok: boolean; detail: string }[]; at: string };
  optedOut: boolean;
  doNotContact: boolean;
  threadIds: string[];
  lastContactAt: string | null;
  owner: string;
  notes: string;
  origin: "research" | "website_form" | "manual" | "import";
  createdAt: string;
}

const NEXT_ALLOWED: Partial<Record<Stage, Stage[]>> = {};
STAGES.forEach((s, i) => (NEXT_ALLOWED[s] = STAGES.slice(i + 1) as unknown as Stage[]));

/** Automated moves can only go forward (or to a terminal stage). The owner can set anything. */
export function canTransition(from: Stage, to: Stage, by: string): boolean {
  if (by === "owner" || by.startsWith("sheet")) return true;
  if ((TERMINAL as readonly string[]).includes(to)) return true;
  if ((TERMINAL as readonly string[]).includes(from)) return false;
  return NEXT_ALLOWED[from]?.includes(to) ?? false;
}

export async function setStage(ctx: Ctx, lead: Lead, to: Stage, by: string, note?: string): Promise<Lead> {
  if (lead.stage === to) return lead;
  if (!canTransition(lead.stage, to, by)) return lead;
  const next: Lead = { ...lead, stage: to, stageHistory: [...lead.stageHistory, { stage: to, at: ctx.now().toISOString(), by, note }] };
  if (to === "Opted Out") (next.optedOut = true), (next.doNotContact = true);
  await saveLead(ctx, next);
  await logActivity(ctx, { actor: by, action: "crm.stage", summary: `${lead.company}: ${lead.stage} → ${to}${note ? ` (${note})` : ""}`, workspaceId: lead.workspaceId, ref: { kind: "lead", id: lead.id } });
  return next;
}

export async function getLead(ctx: Ctx, id: string) {
  return ctx.store.get<Lead>("leads", id);
}

export async function listLeads(ctx: Ctx, filter: Partial<Pick<Lead, "workspaceId" | "country" | "stage">> = {}) {
  return ctx.store.list<Lead>("leads", { where: filter as Record<string, unknown> });
}

export async function saveLead(ctx: Ctx, lead: Lead) {
  await ctx.store.put("leads", lead);
  await upsertNode(ctx, { id: `company:${lead.id}`, kind: "company", label: lead.company, data: { country: lead.country, website: lead.website, stage: lead.stage } });
  await upsertNode(ctx, { id: `country:${lead.country}`, kind: "country", label: lead.country, data: {} });
  await link(ctx, `company:${lead.id}`, "located_in", `country:${lead.country}`);
  return lead;
}

/** Duplicate key: website domain if known, otherwise normalised name + country. */
export function dedupeKeys(l: { company: string; country: string; website?: string; emails?: { address: string }[] }): string[] {
  const keys: string[] = [];
  const d = normalizeDomain(l.website);
  if (d) keys.push(`d:${d}`);
  for (const e of l.emails ?? []) {
    const ed = normalizeDomain(e.address);
    if (ed && !/gmail|yahoo|mail\.ru|yandex|outlook|hotmail|icloud|proton/.test(ed)) keys.push(`d:${ed}`);
  }
  keys.push(`n:${l.country.toUpperCase()}:${normalizeCompanyName(l.company)}`);
  return keys;
}

export async function findDuplicate(ctx: Ctx, candidate: Parameters<typeof dedupeKeys>[0], workspaceId: string): Promise<Lead | null> {
  const keys = new Set(dedupeKeys(candidate));
  for (const l of await listLeads(ctx, { workspaceId })) if (dedupeKeys(l).some((k) => keys.has(k))) return l;
  return null;
}

export function newLead(ctx: Ctx, p: Partial<Lead> & Pick<Lead, "company" | "country" | "workspaceId">): Lead {
  const now = ctx.now().toISOString();
  return {
    id: newId("lead"),
    normalizedName: normalizeCompanyName(p.company),
    domain: normalizeDomain(p.website),
    city: "",
    website: "",
    emails: [],
    phones: [],
    contacts: [],
    description: "",
    portfolioFit: "",
    relevance: 0,
    language: null,
    languageSource: null,
    timezone: null,
    segment: "",
    stage: "Researching",
    stageHistory: [{ stage: p.stage ?? "Researching", at: now, by: "bingo" }],
    sources: [],
    verification: { status: "unverified", checks: [], at: now },
    optedOut: false,
    doNotContact: false,
    threadIds: [],
    lastContactAt: null,
    owner: "",
    notes: "",
    origin: "research",
    createdAt: now,
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Suppression list (opt-outs, bounces, do-not-contact) — checked before every send
// ---------------------------------------------------------------------------

export async function suppress(ctx: Ctx, address: string, reason: string) {
  const a = address.trim().toLowerCase();
  await ctx.store.put("suppression", { id: a, reason, at: ctx.now().toISOString() });
}

export async function isSuppressed(ctx: Ctx, address: string): Promise<string | null> {
  const a = address.trim().toLowerCase();
  const hit = (await ctx.store.get<{ id: string; reason: string }>("suppression", a)) ?? (await ctx.store.get<{ id: string; reason: string }>("suppression", `@${normalizeDomain(a)}`));
  return hit?.reason ?? null;
}

// ---------------------------------------------------------------------------
// Google Sheets two-way sync
// ---------------------------------------------------------------------------

export function leadRow(l: Lead) {
  return {
    "BINGO ID": l.id,
    Company: l.company,
    Country: l.country,
    Website: l.website,
    Email: l.emails.find((e) => e.verified)?.address ?? l.emails[0]?.address ?? "",
    Phone: l.phones[0] ?? "",
    Language: l.language ?? "",
    Stage: l.stage,
    Relevance: l.relevance,
    Verification: l.verification.status,
    Sources: l.sources.map((s) => s.url).slice(0, 3).join(" "),
    Owner: l.owner,
    Notes: l.notes,
    "Last Contact": l.lastContactAt ?? "",
    Updated: new Date().toISOString(),
  };
}

export async function syncLeadsToSheet(ctx: Ctx, leads: Lead[]) {
  if (!leads.length) return { status: "ok" as const, updated: 0, appended: 0 };
  return pushToSheet(ctx, "leads", leads.map(leadRow));
}

/** Applies edits people made in the sheet (Stage, Owner, Notes, Email, Language). */
export async function pullLeadEdits(ctx: Ctx): Promise<number> {
  const edits = await pullFromSheet(ctx, "leads");
  if (!edits) return 0;
  let changed = 0;
  for (const [id, row] of edits) {
    const lead = await getLead(ctx, id);
    if (!lead) continue;
    let next = { ...lead };
    if (row.Owner !== undefined && row.Owner !== lead.owner) next.owner = row.Owner;
    if (row.Notes !== undefined && row.Notes !== lead.notes) next.notes = row.Notes;
    if (row.Language && row.Language !== lead.language) (next.language = row.Language), (next.languageSource = "manual");
    if (row.Email && !lead.emails.some((e) => e.address.toLowerCase() === row.Email!.toLowerCase())) next.emails = [{ address: row.Email, source: "manual", verified: true, note: "entered in Google Sheet" }, ...lead.emails];
    const stage = row.Stage as Stage | undefined;
    if (stage && stage !== lead.stage && ([...STAGES, ...TERMINAL] as readonly string[]).includes(stage)) {
      next = { ...next, stage, stageHistory: [...next.stageHistory, { stage, at: ctx.now().toISOString(), by: "sheet", note: "changed in Google Sheet" }] };
      if (stage === "Opted Out") (next.optedOut = true), (next.doNotContact = true);
    }
    if (JSON.stringify(next) !== JSON.stringify(lead)) {
      await saveLead(ctx, next);
      changed++;
    }
  }
  return changed;
}

/** Common business language per country — a starting point only; replies and manual edits override it. */
export const COUNTRY_LANGUAGE: Record<string, string> = {
  RU: "ru", UZ: "ru", TJ: "ru", KG: "ru", KZ: "ru", TM: "ru", BY: "ru", AM: "ru", AZ: "ru", GE: "ka", UA: "uk",
  KH: "km", LA: "lo", TH: "th", VN: "vi", MM: "my", ID: "id", MY: "ms", PH: "en",
  NP: "ne", BD: "bn", PK: "ur", LK: "si", IN: "en", AF: "fa", IR: "fa",
  AE: "ar", SA: "ar", EG: "ar", IQ: "ar", JO: "ar", KW: "ar", OM: "ar", QA: "ar", MA: "fr", DZ: "fr", TN: "fr",
  FR: "fr", ES: "es", MX: "es", CO: "es", PE: "es", CL: "es", AR: "es", DE: "de", AT: "de", PT: "pt", BR: "pt",
  CN: "zh", TW: "zh-Hant", JP: "ja", KR: "ko", TR: "tr", NG: "en", KE: "en", GB: "en", US: "en",
};

export const COUNTRY_TIMEZONE: Record<string, string> = {
  RU: "Europe/Moscow", UZ: "Asia/Tashkent", TJ: "Asia/Dushanbe", KG: "Asia/Bishkek", KZ: "Asia/Almaty", TM: "Asia/Ashgabat", BY: "Europe/Minsk", GE: "Asia/Tbilisi", AM: "Asia/Yerevan", AZ: "Asia/Baku",
  KH: "Asia/Phnom_Penh", LA: "Asia/Vientiane", TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", MM: "Asia/Yangon", ID: "Asia/Jakarta", MY: "Asia/Kuala_Lumpur", PH: "Asia/Manila",
  NP: "Asia/Kathmandu", BD: "Asia/Dhaka", PK: "Asia/Karachi", LK: "Asia/Colombo", IN: "Asia/Kolkata", AF: "Asia/Kabul", IR: "Asia/Tehran",
  AE: "Asia/Dubai", SA: "Asia/Riyadh", EG: "Africa/Cairo", IQ: "Asia/Baghdad", JO: "Asia/Amman", KW: "Asia/Kuwait", OM: "Asia/Muscat", QA: "Asia/Qatar",
  FR: "Europe/Paris", ES: "Europe/Madrid", DE: "Europe/Berlin", PT: "Europe/Lisbon", GB: "Europe/London", TR: "Europe/Istanbul", UA: "Europe/Kyiv",
  CN: "Asia/Shanghai", JP: "Asia/Tokyo", KR: "Asia/Seoul", NG: "Africa/Lagos", KE: "Africa/Nairobi", BR: "America/Sao_Paulo", MX: "America/Mexico_City",
};

/** Country name → ISO code using Intl (no hard-coded name list). */
export function countryCode(name: string): string | null {
  const n = name.trim();
  if (/^[A-Za-z]{2}$/.test(n)) return n.toUpperCase();
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  const target = n.toLowerCase();
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try {
        const label = dn.of(code);
        if (label && label !== code && label.toLowerCase() === target) return code;
      } catch {
        /* invalid code */
      }
    }
  return null;
}

export function countryName(code: string) {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
