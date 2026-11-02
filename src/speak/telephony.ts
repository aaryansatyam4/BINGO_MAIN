import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Ctx } from "@/core/context";
import { fetchJson } from "@/core/http";
import { getOwner } from "@/core/settings";
import { escapeHtml } from "@/core/util";
import type { Incident } from "./escalation";

/**
 * Telephony for BINGO SPEAK: Twilio (programmable voice with TwiML, speech and
 * keypad input) or Exotel (India; call flows configured in the Exotel app).
 * Credentials live in the vault. Calls to the owner follow the escalation
 * policy; calls to anyone else need explicit approval.
 */
export interface TwilioConfig {
  provider: "twilio";
  accountSid: string;
  authToken: string;
  from: string; // Twilio number in E.164
  voice?: string; // e.g. "Polly.Aditi" or "alice"
  language?: string; // e.g. "en-IN"
}
export interface ExotelConfig {
  provider: "exotel";
  sid: string;
  apiKey: string;
  apiToken: string;
  subdomain: string; // api.exotel.com or api.in.exotel.com
  callerId: string; // ExoPhone
  flowUrl: string; // http://my.exotel.com/<sid>/exoml/start_voice/<app id>
}
export type TelephonyConfig = TwilioConfig | ExotelConfig;

export async function telephonyConfig(ctx: Ctx): Promise<TelephonyConfig | null> {
  return ctx.vault.getJson<TelephonyConfig>("global", "telephony");
}

export async function telephonyReady(ctx: Ctx) {
  const cfg = await telephonyConfig(ctx);
  const owner = await getOwner(ctx);
  return !!cfg && !!owner.phone;
}

/** Signed token for webhook URLs, so only calls BINGO placed can drive the call flow. */
export async function webhookToken(ctx: Ctx, value: string) {
  let key = await ctx.vault.get("global", "webhook:hmac");
  if (!key) {
    key = randomBytes(32).toString("hex");
    await ctx.vault.set("global", "webhook:hmac", key);
  }
  return createHmac("sha256", key).update(value).digest("hex").slice(0, 32);
}

export async function checkWebhookToken(ctx: Ctx, value: string, token: string) {
  const expected = await webhookToken(ctx, value);
  return token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function twimlSay(text: string, opts: { voice?: string; language?: string } = {}) {
  return `<Say${opts.voice ? ` voice="${escapeHtml(opts.voice)}"` : ""}${opts.language ? ` language="${escapeHtml(opts.language)}"` : ""}>${escapeHtml(text)}</Say>`;
}

export async function introTwiml(ctx: Ctx, inc: Pick<Incident, "id" | "title" | "severity">) {
  const cfg = (await telephonyConfig(ctx)) as TwilioConfig;
  const tok = await webhookToken(ctx, inc.id);
  const action = `${ctx.env.publicUrl}/api/webhooks/twilio/voice?incident=${inc.id}&t=${tok}&step=menu`;
  const o = { voice: cfg?.voice, language: cfg?.language ?? "en-IN" };
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech dtmf" numDigits="1" timeout="6" speechTimeout="auto" language="${o.language}" action="${escapeHtml(action)}" method="POST">${twimlSay(
    `Hello, this is BINGO, your AI business assistant. ${inc.severity === "CRITICAL" ? "This is a critical matter." : "This is an important matter."} ${inc.title}. I have prepared the details and recommended options. Would you like a quick summary? Say yes or press 1. Press 2 to acknowledge and read it later.`,
    o,
  )}</Gather>${twimlSay("I did not hear a response. I have sent the details to Telegram. Goodbye.", o)}</Response>`;
}

export async function menuTwiml(ctx: Ctx, inc: Incident, input: { digits?: string; speech?: string }) {
  const cfg = (await telephonyConfig(ctx)) as TwilioConfig;
  const o = { voice: cfg?.voice, language: cfg?.language ?? "en-IN" };
  const tok = await webhookToken(ctx, inc.id);
  const action = `${ctx.env.publicUrl}/api/webhooks/twilio/voice?incident=${inc.id}&t=${tok}&step=after-summary`;
  const said = (input.speech ?? "").toLowerCase();
  const wantsSummary = input.digits === "1" || /\b(yes|yeah|summary|sure|haan|ha|да)\b/.test(said);
  if (!wantsSummary) return `<?xml version="1.0" encoding="UTF-8"?><Response>${twimlSay("Acknowledged. The details are in BINGO and Telegram. Goodbye.", o)}</Response>`;
  const options = inc.options.map((x, i) => `Option ${i + 1}: ${x.label}.`).join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="dtmf" numDigits="1" timeout="8" action="${escapeHtml(action)}" method="POST">${twimlSay(
    `${inc.summary} My recommendation: ${inc.recommendation} ${options} I will not commit to anything without your written approval in BINGO or Telegram. Press 1 to acknowledge.`,
    o,
  )}</Gather>${twimlSay("Thank you. I will wait for your decision in BINGO. Goodbye.", o)}</Response>`;
}

export async function placeOwnerCall(ctx: Ctx, inc: Incident): Promise<{ sid: string; status: string; provider: string }> {
  const cfg = await telephonyConfig(ctx);
  const owner = await getOwner(ctx);
  if (!cfg) throw new Error("No telephony provider connected (Settings → Connections → Phone calls).");
  if (!/^\+\d{8,15}$/.test(owner.phone)) throw new Error("Owner phone number must be in international format, e.g. +9198…");
  const tok = await webhookToken(ctx, inc.id);
  const statusUrl = `${ctx.env.publicUrl}/api/webhooks/twilio/status?incident=${inc.id}&t=${tok}`;
  if (cfg.provider === "twilio") {
    const r = await fetchJson<{ sid: string; status: string }>(ctx, `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`, {
      headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}` },
      form: { To: owner.phone, From: cfg.from, Twiml: await introTwiml(ctx, inc), StatusCallback: statusUrl, StatusCallbackMethod: "POST", Timeout: "30", MachineDetection: "Enable" },
    });
    return { sid: r.sid, status: r.status, provider: "twilio" };
  }
  const r = await fetchJson<{ Call: { Sid: string; Status: string } }>(ctx, `https://${cfg.subdomain}/v1/Accounts/${cfg.sid}/Calls/connect.json`, {
    headers: { authorization: `Basic ${Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`).toString("base64")}` },
    form: { From: owner.phone, CallerId: cfg.callerId, Url: cfg.flowUrl, StatusCallback: statusUrl, CustomField: inc.id },
  });
  return { sid: r.Call.Sid, status: r.Call.Status, provider: "exotel" };
}

/** Validates X-Twilio-Signature (HMAC-SHA1 of URL + sorted POST params). */
export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
