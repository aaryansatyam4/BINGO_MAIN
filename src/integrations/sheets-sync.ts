import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { authorize } from "@/core/policy";
import { errorMessage } from "@/core/util";
import { ensureTab, googleConnected, readSheetRecords, upsertSheetRows } from "./google";

/**
 * Google Sheets is BINGO's primary *editable* business data surface.
 * Each dataset (leads, outreach, meetings, deployments, creatives…) is linked
 * to a spreadsheet tab. BINGO writes its own columns by header name and reads
 * back the columns people are allowed to edit (e.g. Stage, Owner, Notes).
 */
export type Dataset = "leads" | "outreach" | "meetings" | "deployments" | "creatives" | "reports";

export interface SheetLink {
  id: Dataset;
  spreadsheetId: string;
  tab: string;
  idHeader: string;
  /** Columns people may edit in the sheet; pulled back into BINGO. */
  editable: string[];
  workspaceId?: string;
  lastPushAt?: string;
  lastPullAt?: string;
  lastError?: string;
}

export const DATASET_HEADERS: Record<Dataset, { headers: string[]; editable: string[] }> = {
  leads: {
    headers: ["BINGO ID", "Company", "Country", "Website", "Email", "Phone", "Language", "Stage", "Relevance", "Verification", "Sources", "Owner", "Notes", "Last Contact", "Updated"],
    editable: ["Stage", "Owner", "Notes", "Email", "Language"],
  },
  outreach: { headers: ["BINGO ID", "Lead ID", "Company", "To", "Subject", "Language", "Status", "Gmail Message ID", "Thread ID", "Sent At", "Approved By"], editable: [] },
  meetings: {
    headers: ["BINGO ID", "Contact", "Company", "Country", "Start (owner time)", "Start (contact time)", "Status", "Calendar Event", "Meet Link", "Objective", "Next Steps"],
    editable: ["Next Steps", "Objective"],
  },
  deployments: { headers: ["BINGO ID", "Project", "Environment", "URL", "Status", "Commit", "Created", "Approved By"], editable: [] },
  creatives: { headers: ["BINGO ID", "Brand", "Product", "Concept", "Status", "Formats", "Version", "Updated"], editable: ["Status"] },
  reports: { headers: ["BINGO ID", "Title", "Language", "Created", "Delivered To", "File"], editable: [] },
};

export async function getSheetLink(ctx: Ctx, id: Dataset) {
  return ctx.store.get<SheetLink>("sheet_links", id);
}

export async function saveSheetLink(ctx: Ctx, link: Omit<SheetLink, "editable" | "idHeader"> & Partial<Pick<SheetLink, "editable" | "idHeader">>, createTab = true) {
  const def = DATASET_HEADERS[link.id];
  const full: SheetLink = { idHeader: "BINGO ID", editable: def.editable, ...link };
  if (createTab) await ensureTab(ctx, full.spreadsheetId, full.tab, def.headers, full.workspaceId);
  await ctx.store.put("sheet_links", full);
  return full;
}

/** Push rows for one dataset. Returns a status; never throws for "not configured". */
export async function pushToSheet(ctx: Ctx, dataset: Dataset, rows: Record<string, string | number | boolean | null>[], requestedBy = "bingo") {
  const link = await getSheetLink(ctx, dataset);
  if (!link) return { status: "not_configured" as const, message: `No Google Sheet linked for ${dataset}. Settings → Connections → Google Sheets.` };
  if (!(await googleConnected(ctx, link.workspaceId))) return { status: "not_configured" as const, message: "Google is not connected." };
  const auth = await authorize(ctx, { kind: "sheet.write", workspaceId: link.workspaceId, payload: { dataset, ids: rows.map((r) => r["BINGO ID"]) }, title: `Update ${dataset} sheet`, summary: `${rows.length} rows`, requestedBy });
  if (!auth.allowed) return { status: "blocked" as const, message: auth.reason };
  try {
    const r = await upsertSheetRows(ctx, link, rows);
    await ctx.store.put("sheet_links", { ...link, lastPushAt: ctx.now().toISOString(), lastError: undefined });
    return { status: "ok" as const, ...r };
  } catch (e) {
    await ctx.store.put("sheet_links", { ...link, lastError: errorMessage(e) });
    await logActivity(ctx, { actor: "bingo", action: "sheets.error", summary: `Could not update ${dataset} sheet: ${errorMessage(e)}`, level: "error" });
    return { status: "error" as const, message: errorMessage(e) };
  }
}

/** Reads the human-editable columns back. Caller applies them to its records. */
export async function pullFromSheet(ctx: Ctx, dataset: Dataset): Promise<Map<string, Record<string, string>> | null> {
  const link = await getSheetLink(ctx, dataset);
  if (!link || !(await googleConnected(ctx, link.workspaceId))) return null;
  const rows = await readSheetRecords(ctx, link.spreadsheetId, link.tab, link.workspaceId);
  const out = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const id = r[link.idHeader];
    if (!id) continue;
    out.set(id, Object.fromEntries(link.editable.map((h) => [h, r[h] ?? ""])));
  }
  await ctx.store.put("sheet_links", { ...link, lastPullAt: ctx.now().toISOString() });
  return out;
}
