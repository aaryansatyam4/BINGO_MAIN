import { getCtx } from "@/core/context";
import { tick } from "@/orchestrator/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 24/7 heartbeat: Vercel Cron (Authorization: Bearer CRON_SECRET) or the standalone worker. */
export async function GET(req: Request) {
  const ctx = getCtx();
  const secret = ctx.env.cronSecret;
  if (!secret) return Response.json({ error: "Set CRON_SECRET to enable the scheduler." }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const result = await tick(ctx);
  return Response.json({ ok: true, at: ctx.now().toISOString(), result });
}
