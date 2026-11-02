import { getCtx } from "@/core/context";
import { getOwner } from "@/core/settings";
import { escapeHtml } from "@/core/util";
import { telegramAnswerCallback, telegramSend } from "@/integrations/telegram";
import { askBingo } from "@/orchestrator/planner";
import { acknowledge, decide } from "@/speak/escalation";
import { decideAndContinue } from "@/web/approvals";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Telegram bot webhook. Verified by the secret token header set at setWebhook
 * time AND by the owner's chat id, so nobody else can approve or instruct BINGO.
 */
export async function POST(req: Request) {
  const ctx = getCtx();
  const secret = await ctx.vault.get("global", "telegram:webhook_secret");
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });
  const owner = await getOwner(ctx);
  const update = (await req.json()) as {
    callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
    message?: { chat: { id: number }; text?: string };
  };
  const chatId = String(update.callback_query?.message?.chat.id ?? update.message?.chat.id ?? "");
  if (update.message?.text?.startsWith("/start")) {
    await telegramSend(ctx, `Your chat ID is <code>${escapeHtml(chatId)}</code>. Paste it in BINGO → Settings → Connections → Telegram.`, { chatId });
    return Response.json({ ok: true });
  }
  if (!owner.telegramChatId || chatId !== owner.telegramChatId) return Response.json({ ok: true, ignored: "not the owner" });

  if (update.callback_query?.data) {
    const [kind, id, arg] = update.callback_query.data.split(":");
    let text = "Done";
    try {
      if (kind === "apr") text = (await decideAndContinue(ctx, id!, arg === "y" ? "approved" : "rejected", "telegram")).result;
      else if (kind === "ack") text = (await acknowledge(ctx, id!, "telegram"), "Acknowledged");
      else if (kind === "opt") text = `Recorded: ${(await decide(ctx, id!, Number(arg), "telegram")).decision?.option}. BINGO will not commit on your behalf; reply in BINGO to act.`;
    } catch (e) {
      text = e instanceof Error ? e.message : String(e);
    }
    await telegramAnswerCallback(ctx, update.callback_query.id, text.slice(0, 190));
    await telegramSend(ctx, escapeHtml(text));
    return Response.json({ ok: true });
  }
  if (update.message?.text) {
    const { workflow, plan } = await askBingo(ctx, update.message.text);
    await telegramSend(ctx, workflow ? `🧭 Plan started (${workflow.steps.length} steps): ${escapeHtml(workflow.goal)}\n${ctx.env.publicUrl}/workflows/${workflow.id}` : escapeHtml(plan.notes.join("\n") || "I could not plan that."));
  }
  return Response.json({ ok: true });
}
