import { redirect } from "next/navigation";
import { getCtx, logActivity } from "@/core/context";
import { vercelExchangeCode } from "@/integrations/vercel";

/** Vercel Integration install callback (Settings → Connections → Vercel → Authorize). */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ctx = getCtx();
  const user = await vercelExchangeCode(ctx, u.searchParams.get("code") ?? "");
  await logActivity(ctx, { actor: "owner", action: "connection.vercel", summary: `Vercel connected (${user})`, level: "success" });
  redirect(u.searchParams.get("next") ?? "/settings#connections");
}
