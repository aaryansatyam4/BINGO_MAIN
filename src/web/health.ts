import type { Ctx } from "@/core/context";
import { getOwner } from "@/core/settings";
import { listConnections } from "@/ai/engine";
import { googleConnected } from "@/integrations/google";
import { githubAuth } from "@/integrations/github";
import { vercelAuth } from "@/integrations/vercel";
import { getTaskConfig } from "@/integrations/tasks";
import { telegramReady } from "@/integrations/telegram";
import { telephonyReady } from "@/speak/telephony";
import { jobStatus } from "@/orchestrator/scheduler";

/** What is connected, so BINGO can be honest about what it can and cannot do right now. */
export async function connectionHealth(ctx: Ctx) {
  const owner = await getOwner(ctx);
  const ai = await listConnections(ctx);
  const sandbox = (await ctx.vault.get("global", "vercel:sandbox")) || process.env.VERCEL_OIDC_TOKEN ? "Vercel Sandbox" : ctx.env.allowLocalSandbox ? "local (dev only)" : null;
  const { heartbeat } = await jobStatus(ctx);
  const items = [
    { key: "ai", label: "AI models", ok: ai.some((c) => c.enabled && c.lastTest?.ok !== false), detail: ai.length ? ai.map((c) => c.id).join(", ") : "Connect Claude first", href: "/settings#ai" },
    { key: "google", label: "Google (Gmail, Calendar, Sheets)", ok: !!(await googleConnected(ctx)), detail: (await googleConnected(ctx))?.email ?? "Authorize Google", href: "/settings#connections" },
    { key: "tasks", label: "Company task sheet", ok: !!(await getTaskConfig(ctx))?.apiUrl, detail: (await getTaskConfig(ctx))?.apiUrl ? "ISSHAAN task system" : "Connect the existing task sheet", href: "/settings#connections" },
    { key: "github", label: "GitHub", ok: !!(await githubAuth(ctx)), detail: (await githubAuth(ctx))?.login ?? "Authorize GitHub", href: "/settings#connections" },
    { key: "vercel", label: "Vercel", ok: !!(await vercelAuth(ctx)), detail: (await vercelAuth(ctx))?.user ?? "Authorize Vercel", href: "/settings#connections" },
    { key: "sandbox", label: "Isolated build sandbox", ok: !!sandbox, detail: sandbox ?? "Needed to test generated code", href: "/settings#connections" },
    { key: "telegram", label: "Telegram", ok: await telegramReady(ctx), detail: owner.telegramChatId ? "chat linked" : "Add bot + chat ID", href: "/settings#connections" },
    { key: "phone", label: "Phone calls", ok: await telephonyReady(ctx), detail: owner.phone || "Add Twilio/Exotel + your number", href: "/settings#connections" },
    { key: "cron", label: "24/7 scheduler", ok: !!heartbeat && Date.now() - new Date(heartbeat).getTime() < 10 * 60_000, detail: heartbeat ? `last heartbeat ${new Date(heartbeat).toLocaleString()}` : "Set CRON_SECRET (Vercel Cron) or run the worker", href: "/activity" },
    { key: "db", label: "Durable database", ok: ctx.store.kind === "postgres" || (!ctx.env.isProduction && ctx.store.kind === "file"), detail: ctx.store.kind, href: "/settings" },
  ];
  return items;
}
