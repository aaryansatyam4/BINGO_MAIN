import { getCtx } from "@/core/context";
import type { Incident } from "@/speak/escalation";
import { checkWebhookToken, telephonyConfig, validTwilioSignature } from "@/speak/telephony";

export const dynamic = "force-dynamic";

/** Call status callbacks: records real call outcomes (completed, no-answer, busy, failed). */
export async function POST(req: Request) {
  const ctx = getCtx();
  const url = new URL(req.url);
  const params = Object.fromEntries((await req.formData()).entries()) as Record<string, string>;
  const cfg = await telephonyConfig(ctx);
  const incidentId = url.searchParams.get("incident") ?? "";
  if (!(await checkWebhookToken(ctx, incidentId, url.searchParams.get("t") ?? ""))) return new Response("forbidden", { status: 403 });
  if (cfg?.provider === "twilio" && !validTwilioSignature(cfg.authToken, `${ctx.env.publicUrl}${url.pathname}${url.search}`, params, req.headers.get("x-twilio-signature") ?? "")) return new Response("forbidden", { status: 403 });
  const inc = await ctx.store.get<Incident>("incidents", incidentId);
  if (inc) {
    const sid = params.CallSid ?? params.Sid;
    const calls = inc.calls.map((c) => (c.sid === sid ? { ...c, status: params.CallStatus ?? params.Status ?? c.status } : c));
    await ctx.store.put("incidents", { ...inc, calls });
  }
  return new Response("ok");
}
