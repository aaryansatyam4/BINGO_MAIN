import type { Ctx } from "@/core/context";
import { fetchJson } from "@/core/http";
import { getOwner } from "@/core/settings";
import { escapeHtml } from "@/core/util";

/** Telegram Bot API: owner notifications, documents and approve/reject buttons. */

async function botToken(ctx: Ctx): Promise<string | null> {
  return process.env.TELEGRAM_BOT_TOKEN ?? (await ctx.vault.get("global", "telegram:bot_token"));
}

export async function telegramReady(ctx: Ctx): Promise<boolean> {
  const owner = await getOwner(ctx);
  return !!(owner.telegramChatId && (await botToken(ctx)));
}

export interface TgButton {
  text: string;
  data: string;
}

export async function telegramSend(ctx: Ctx, html: string, opts: { buttons?: TgButton[][]; chatId?: string } = {}): Promise<{ messageId: number } | { skipped: string }> {
  const token = await botToken(ctx);
  const chatId = opts.chatId ?? (await getOwner(ctx)).telegramChatId;
  if (!token || !chatId) return { skipped: "Telegram is not connected (bot token + your chat ID)." };
  const r = await fetchJson<{ ok: boolean; result: { message_id: number }; description?: string }>(ctx, `https://api.telegram.org/bot${token}/sendMessage`, {
    body: {
      chat_id: chatId,
      text: html.slice(0, 4000),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
    },
  });
  if (!r.ok) throw new Error(`Telegram: ${r.description}`);
  return { messageId: r.result.message_id };
}

export async function telegramSendDocument(ctx: Ctx, file: { filename: string; mime: string; data: Buffer }, caption: string): Promise<{ messageId: number } | { skipped: string }> {
  const token = await botToken(ctx);
  const chatId = (await getOwner(ctx)).telegramChatId;
  if (!token || !chatId) return { skipped: "Telegram is not connected." };
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption.slice(0, 1000));
  form.append("parse_mode", "HTML");
  form.append("document", new Blob([new Uint8Array(file.data)], { type: file.mime }), file.filename);
  const res = await ctx.fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
  const r = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
  if (!r.ok) throw new Error(`Telegram: ${r.description}`);
  return { messageId: r.result!.message_id };
}

export async function telegramAnswerCallback(ctx: Ctx, callbackId: string, text: string) {
  const token = await botToken(ctx);
  if (!token) return;
  await fetchJson(ctx, `https://api.telegram.org/bot${token}/answerCallbackQuery`, { body: { callback_query_id: callbackId, text } });
}

export async function telegramSetWebhook(ctx: Ctx) {
  const token = await botToken(ctx);
  if (!token) throw new Error("Add the Telegram bot token first.");
  let secret = await ctx.vault.get("global", "telegram:webhook_secret");
  if (!secret) {
    secret = crypto.randomUUID().replace(/-/g, "");
    await ctx.vault.set("global", "telegram:webhook_secret", secret);
  }
  return fetchJson(ctx, `https://api.telegram.org/bot${token}/setWebhook`, {
    body: { url: `${ctx.env.publicUrl}/api/webhooks/telegram`, secret_token: secret, allowed_updates: ["message", "callback_query"] },
  });
}

export function approvalMessage(a: { title: string; summary: string; id: string }): { html: string; buttons: TgButton[][] } {
  return {
    html: `🟡 <b>Approval needed</b>\n${escapeHtml(a.title)}\n\n${escapeHtml(a.summary).slice(0, 2500)}`,
    buttons: [[{ text: "✅ Approve", data: `apr:${a.id}:y` }, { text: "❌ Reject", data: `apr:${a.id}:n` }]],
  };
}
