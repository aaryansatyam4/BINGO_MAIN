import { getCtx } from "@/core/context";
import type { Incident } from "@/speak/escalation";
import { acknowledge } from "@/speak/escalation";
import { checkWebhookToken, introTwiml, menuTwiml, telephonyConfig, validTwilioSignature } from "@/speak/telephony";

export const dynamic = "force-dynamic";

const xml = (body: string) => new Response(body, { headers: { "content-type": "text/xml" } });

/** Voice conversation for BINGO PRIORITY CALL (Twilio <Gather> callbacks). */
export async function POST(req: Request) {
  const ctx = getCtx();
  const url = new URL(req.url);
  const params = Object.fromEntries((await req.formData()).entries()) as Record<string, string>;
  const cfg = await telephonyConfig(ctx);
  const incidentId = url.searchParams.get("incident") ?? "";
  const publicUrl = `${ctx.env.publicUrl}${url.pathname}${url.search}`;
  if (cfg?.provider !== "twilio" || !validTwilioSignature(cfg.authToken, publicUrl, params, req.headers.get("x-twilio-signature") ?? "")) return new Response("forbidden", { status: 403 });
  if (!(await checkWebhookToken(ctx, incidentId, url.searchParams.get("t") ?? ""))) return new Response("forbidden", { status: 403 });
  const inc = await ctx.store.get<Incident>("incidents", incidentId);
  if (!inc) return xml(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, I could not find this matter. Goodbye.</Say></Response>`);
  const step = url.searchParams.get("step");
  if (!step) return xml(await introTwiml(ctx, inc));
  if (step === "menu") {
    if (params.Digits === "2") await acknowledge(ctx, inc.id, "phone");
    return xml(await menuTwiml(ctx, inc, { digits: params.Digits, speech: params.SpeechResult }));
  }
  if (params.Digits === "1") await acknowledge(ctx, inc.id, "phone");
  return xml(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thank you. Goodbye.</Say></Response>`);
}
