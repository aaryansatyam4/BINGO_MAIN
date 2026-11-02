import { redirect } from "next/navigation";
import { getCtx } from "@/core/context";
import { githubOAuthUrl } from "@/integrations/github";
import { newState } from "@/web/oauth-state";

export async function GET() {
  redirect(await githubOAuthUrl(getCtx(), await newState("github")));
}
