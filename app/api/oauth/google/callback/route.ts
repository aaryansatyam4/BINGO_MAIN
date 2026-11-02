import { redirect } from "next/navigation";
import { getCtx, logActivity } from "@/core/context";
import { googleExchangeCode } from "@/integrations/google";
import { checkState } from "@/web/oauth-state";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const [state, scope] = (u.searchParams.get("state") ?? "").split("|");
  if (!(await checkState("google", state ?? null))) return new Response("Invalid OAuth state", { status: 400 });
  const code = u.searchParams.get("code");
  if (!code) return new Response(`Google authorization failed: ${u.searchParams.get("error") ?? "no code"}`, { status: 400 });
  const ctx = getCtx();
  const r = await googleExchangeCode(ctx, code, scope || "global");
  await logActivity(ctx, { actor: "owner", action: "connection.google", summary: `Google connected (${r.email ?? "account"}) for ${scope || "all workspaces"}`, level: "success" });
  redirect("/settings#connections");
}
