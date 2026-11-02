import type { Ctx } from "@/core/context";
import { HttpError, fetchJson } from "@/core/http";

/**
 * Google OAuth (least-privilege scopes) + thin clients for Gmail, Calendar and
 * Sheets REST APIs. Tokens live in the vault per workspace ("global" = owner).
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/contacts.readonly",
];

interface GoogleTokens {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
  scope?: string;
  email?: string;
}

export async function googleClient(ctx: Ctx): Promise<{ clientId: string; clientSecret: string } | null> {
  const id = process.env.GOOGLE_CLIENT_ID ?? (await ctx.vault.get("global", "google:client_id"));
  const secret = process.env.GOOGLE_CLIENT_SECRET ?? (await ctx.vault.get("global", "google:client_secret"));
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

export function googleRedirectUri(ctx: Ctx) {
  return `${ctx.env.publicUrl}/api/oauth/google/callback`;
}

export async function googleAuthUrl(ctx: Ctx, state: string): Promise<string> {
  const c = await googleClient(ctx);
  if (!c) throw new Error("Add your Google OAuth client ID and secret first (Settings → Connections → Google).");
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: googleRedirectUri(ctx),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function googleExchangeCode(ctx: Ctx, code: string, scope: string) {
  const c = await googleClient(ctx);
  if (!c) throw new Error("Google OAuth client is not configured.");
  const t = await fetchJson<{ access_token: string; refresh_token?: string; expires_in: number; scope: string; id_token?: string }>(ctx, "https://oauth2.googleapis.com/token", {
    form: { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: googleRedirectUri(ctx), grant_type: "authorization_code" },
  });
  if (!t.refresh_token) throw new Error("Google did not return a refresh token. Remove BINGO's access in your Google account and connect again.");
  let email: string | undefined;
  if (t.id_token) {
    try {
      email = JSON.parse(Buffer.from(t.id_token.split(".")[1]!, "base64url").toString()).email;
    } catch {
      /* ignore */
    }
  }
  const tokens: GoogleTokens = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in - 60) * 1000, scope: t.scope, email };
  await ctx.vault.setJson(scope, "google", tokens, { email: email ?? "" });
  return { email, scope: t.scope };
}

export async function googleConnected(ctx: Ctx, workspaceId?: string): Promise<{ email?: string } | null> {
  const t = (workspaceId ? await ctx.vault.getJson<GoogleTokens>(workspaceId, "google") : null) ?? (await ctx.vault.getJson<GoogleTokens>("global", "google"));
  return t ? { email: t.email } : null;
}

async function accessToken(ctx: Ctx, workspaceId?: string): Promise<string> {
  const scope = workspaceId && (await ctx.vault.get(workspaceId, "google")) ? workspaceId : "global";
  const t = await ctx.vault.getJson<GoogleTokens>(scope, "google");
  if (!t) throw new Error("Google is not connected. Settings → Connections → Google → Authorize.");
  if (t.access_token && t.expires_at && t.expires_at > Date.now()) return t.access_token;
  const c = await googleClient(ctx);
  if (!c) throw new Error("Google OAuth client is not configured.");
  const r = await fetchJson<{ access_token: string; expires_in: number }>(ctx, "https://oauth2.googleapis.com/token", {
    form: { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: t.refresh_token, grant_type: "refresh_token" },
  });
  await ctx.vault.setJson(scope, "google", { ...t, access_token: r.access_token, expires_at: Date.now() + (r.expires_in - 60) * 1000 }, { email: t.email ?? "" });
  return r.access_token;
}

export async function googleApi<T>(ctx: Ctx, url: string, init: { method?: string; body?: unknown; workspaceId?: string } = {}): Promise<T> {
  const token = await accessToken(ctx, init.workspaceId);
  return fetchJson<T>(ctx, url, { method: init.method, body: init.body, headers: { authorization: `Bearer ${token}` } });
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

export interface OutgoingEmail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  listUnsubscribe?: string;
  attachments?: { filename: string; mime: string; b64: string }[];
}

const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();

export function buildMime(e: OutgoingEmail, from?: string): string {
  const boundary = `bingo_${Math.random().toString(36).slice(2)}`;
  const alt = `alt_${Math.random().toString(36).slice(2)}`;
  const headers = [
    ...(from ? [`From: ${from}`] : []),
    `To: ${e.to.join(", ")}`,
    ...(e.cc?.length ? [`Cc: ${e.cc.join(", ")}`] : []),
    `Subject: ${encWord(e.subject)}`,
    "MIME-Version: 1.0",
    ...(e.inReplyTo ? [`In-Reply-To: ${e.inReplyTo}`, `References: ${e.references ?? e.inReplyTo}`] : []),
    ...(e.listUnsubscribe ? [`List-Unsubscribe: ${e.listUnsubscribe}`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] : []),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts: string[] = [];
  const body = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(e.text, "utf8").toString("base64")),
    ...(e.html ? [`--${alt}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(e.html, "utf8").toString("base64"))] : []),
    `--${alt}--`,
  ].join("\r\n");
  parts.push(body);
  for (const a of e.attachments ?? []) {
    parts.push(
      [`Content-Type: ${a.mime}; name="${encWord(a.filename)}"`, `Content-Disposition: attachment; filename="${encWord(a.filename)}"`, "Content-Transfer-Encoding: base64", "", wrap76(a.b64)].join("\r\n"),
    );
  }
  return `${headers.join("\r\n")}\r\n\r\n${parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n")}\r\n--${boundary}--`;
}

export async function gmailSend(ctx: Ctx, e: OutgoingEmail, workspaceId?: string): Promise<{ id: string; threadId: string; labelIds?: string[] }> {
  const raw = Buffer.from(buildMime(e), "utf8").toString("base64url");
  return googleApi(ctx, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { body: { raw, ...(e.threadId ? { threadId: e.threadId } : {}) }, workspaceId });
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  from: string;
  to: string;
  subject: string;
  messageId: string;
  date: string;
  text: string;
  labelIds: string[];
}

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };

function findText(p: Part): string {
  if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const c of p.parts ?? []) {
    const t = findText(c);
    if (t) return t;
  }
  if (p.mimeType === "text/html" && p.body?.data)
    return Buffer.from(p.body.data, "base64url")
      .toString("utf8")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  return "";
}

export function parseGmailMessage(m: { id: string; threadId: string; internalDate: string; labelIds?: string[]; payload: Part }): GmailMessage {
  const h = (n: string) => m.payload.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  return {
    id: m.id,
    threadId: m.threadId,
    internalDate: m.internalDate,
    from: h("From"),
    to: h("To"),
    subject: h("Subject"),
    messageId: h("Message-ID") || h("Message-Id"),
    date: h("Date"),
    text: findText(m.payload),
    labelIds: m.labelIds ?? [],
  };
}

export async function gmailThread(ctx: Ctx, threadId: string, workspaceId?: string): Promise<GmailMessage[]> {
  const t = await googleApi<{ messages: Parameters<typeof parseGmailMessage>[0][] }>(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`, { workspaceId });
  return (t.messages ?? []).map(parseGmailMessage);
}

export async function gmailGetMessage(ctx: Ctx, id: string, workspaceId?: string): Promise<GmailMessage> {
  const m = await googleApi<Parameters<typeof parseGmailMessage>[0]>(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { workspaceId });
  return parseGmailMessage(m);
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export async function calendarFreeBusy(ctx: Ctx, timeMin: Date, timeMax: Date, calendarId = "primary", workspaceId?: string): Promise<{ start: string; end: string }[]> {
  const r = await googleApi<{ calendars: Record<string, { busy: { start: string; end: string }[]; errors?: unknown[] }> }>(ctx, "https://www.googleapis.com/calendar/v3/freeBusy", {
    body: { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: calendarId }] },
    workspaceId,
  });
  const cal = r.calendars[calendarId];
  if (cal?.errors?.length) throw new Error(`Calendar free/busy error: ${JSON.stringify(cal.errors)}`);
  return cal?.busy ?? [];
}

export interface CalendarEventInput {
  summary: string;
  description: string;
  start: string; // RFC3339
  end: string;
  timeZone: string;
  attendees: { email: string; displayName?: string }[];
  withMeet: boolean;
  requestId: string; // idempotency for the Meet link
}

export interface CalendarEvent {
  id: string;
  htmlLink: string;
  status: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[]; createRequest?: { status?: { statusCode: string } } };
  attendees?: { email: string; responseStatus: "needsAction" | "declined" | "tentative" | "accepted" }[];
  start: { dateTime: string };
  end: { dateTime: string };
}

export async function calendarInsert(ctx: Ctx, e: CalendarEventInput, workspaceId?: string): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {
    summary: e.summary,
    description: e.description,
    start: { dateTime: e.start, timeZone: e.timeZone },
    end: { dateTime: e.end, timeZone: e.timeZone },
    attendees: e.attendees,
    reminders: { useDefault: true },
  };
  if (e.withMeet) body.conferenceData = { createRequest: { requestId: e.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  return googleApi(ctx, `https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, { body, workspaceId });
}

export async function calendarGet(ctx: Ctx, eventId: string, workspaceId?: string): Promise<CalendarEvent> {
  return googleApi(ctx, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, { workspaceId });
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const a1 = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

export function columnLetter(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function sheetValues(ctx: Ctx, spreadsheetId: string, range: string, workspaceId?: string): Promise<string[][]> {
  const r = await googleApi<{ values?: string[][] }>(ctx, `${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, { workspaceId });
  return r.values ?? [];
}

export async function sheetTabs(ctx: Ctx, spreadsheetId: string, workspaceId?: string): Promise<string[]> {
  const r = await googleApi<{ sheets: { properties: { title: string } }[] }>(ctx, `${SHEETS}/${spreadsheetId}?fields=sheets.properties.title`, { workspaceId });
  return r.sheets.map((s) => s.properties.title);
}

/** Creates a BINGO-owned tab with headers if it does not exist. Never touches existing tabs' schema. */
export async function ensureTab(ctx: Ctx, spreadsheetId: string, tab: string, headers: string[], workspaceId?: string) {
  const tabs = await sheetTabs(ctx, spreadsheetId, workspaceId);
  if (tabs.includes(tab)) return false;
  await googleApi(ctx, `${SHEETS}/${spreadsheetId}:batchUpdate`, { body: { requests: [{ addSheet: { properties: { title: tab } } }] }, workspaceId });
  await googleApi(ctx, `${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(`${a1(tab)}!A1`)}?valueInputOption=RAW`, { method: "PUT", body: { values: [headers] }, workspaceId });
  return true;
}

/**
 * Upserts records by a stable ID column. Only the columns BINGO maps are
 * written; every other cell is sent as null, which the Sheets API skips, so
 * formulas, formatting and the owner's extra columns are preserved.
 */
export async function upsertSheetRows(
  ctx: Ctx,
  link: { spreadsheetId: string; tab: string; idHeader: string; workspaceId?: string },
  rows: Record<string, string | number | boolean | null>[],
): Promise<{ updated: number; appended: number; missingHeaders: string[] }> {
  const values = await sheetValues(ctx, link.spreadsheetId, `${a1(link.tab)}`, link.workspaceId);
  const header = values[0] ?? [];
  const idCol = header.indexOf(link.idHeader);
  if (idCol < 0) throw new Error(`Sheet "${link.tab}" has no "${link.idHeader}" column. Add it (BINGO uses it to avoid duplicates).`);
  const missing = new Set<string>();
  const rowOf = new Map<string, number>();
  values.slice(1).forEach((r, i) => r[idCol] && rowOf.set(String(r[idCol]), i + 2));
  const updates: { range: string; values: (string | number | boolean | null)[][] }[] = [];
  const appends: (string | number | boolean | null)[][] = [];
  for (const rec of rows) {
    for (const k of Object.keys(rec)) if (!header.includes(k)) missing.add(k);
    const arr = header.map((h) => (h in rec ? rec[h]! : null));
    const id = String(rec[link.idHeader] ?? "");
    if (!id) throw new Error(`Row without ${link.idHeader}`);
    const at = rowOf.get(id);
    if (at) updates.push({ range: `${a1(link.tab)}!A${at}:${columnLetter(header.length - 1)}${at}`, values: [arr] });
    else appends.push(arr);
  }
  if (updates.length) {
    await googleApi(ctx, `${SHEETS}/${link.spreadsheetId}/values:batchUpdate`, { body: { valueInputOption: "USER_ENTERED", data: updates }, workspaceId: link.workspaceId });
  }
  if (appends.length) {
    await googleApi(ctx, `${SHEETS}/${link.spreadsheetId}/values/${encodeURIComponent(`${a1(link.tab)}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      body: { values: appends },
      workspaceId: link.workspaceId,
    });
  }
  return { updated: updates.length, appended: appends.length, missingHeaders: [...missing] };
}

export async function readSheetRecords(ctx: Ctx, spreadsheetId: string, tab: string, workspaceId?: string): Promise<Record<string, string>[]> {
  const values = await sheetValues(ctx, spreadsheetId, a1(tab), workspaceId);
  const header = values[0] ?? [];
  return values.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

export function isAuthError(e: unknown) {
  return e instanceof HttpError && (e.status === 401 || e.status === 403);
}
