import { redirect } from "next/navigation";
import { getCtx, logActivity } from "@/core/context";
import { githubExchangeCode } from "@/integrations/github";
import { checkState } from "@/web/oauth-state";

export async function GET(req: Request) {
  const u = new URL(req.url);
  if (!(await checkState("github", u.searchParams.get("state")))) return new Response("Invalid OAuth state", { status: 400 });
  const ctx = getCtx();
  const login = await githubExchangeCode(ctx, u.searchParams.get("code") ?? "");
  await logActivity(ctx, { actor: "owner", action: "connection.github", summary: `GitHub connected as ${login}`, level: "success" });
  redirect("/settings#connections");
}
