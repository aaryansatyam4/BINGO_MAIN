import { redirect } from "next/navigation";
import { getCtx } from "@/core/context";
import { googleAuthUrl } from "@/integrations/google";
import { newState } from "@/web/oauth-state";

export async function GET(req: Request) {
  const scope = new URL(req.url).searchParams.get("workspace") || "global";
  const state = `${await newState("google")}|${scope}`;
  redirect(await googleAuthUrl(getCtx(), state));
}
