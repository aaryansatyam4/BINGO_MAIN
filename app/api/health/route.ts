import { getCtx } from "@/core/context";
import { jobStatus } from "@/orchestrator/scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = getCtx();
  const { heartbeat } = await jobStatus(ctx);
  return Response.json({ ok: true, store: ctx.store.kind, heartbeat });
}
