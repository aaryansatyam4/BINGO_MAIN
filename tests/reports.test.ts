import { afterEach, describe, expect, it } from "vitest";
import { setAdapterFactory } from "@/ai/engine";
import { saveOwner } from "@/core/settings";
import { deliverReport, generateReport, templateDue } from "@/reports/report";
import { connectFakeAi } from "./fakes/ai";
import { World } from "./fakes/world";
import { connectGoogle } from "./fixtures";
import { testCtx } from "./helpers";

afterEach(() => setAdapterFactory(null));

const research = { research: { text: "Cambodia pharmacy market grew from USD 100m (2024) to USD 112m (2025).", sources: [{ url: "https://example.org/a", title: "Market study" }] } };

describe("AI reports", () => {
  it("“Make a complete expansion report for Cambodia … send it to my Gmail and Telegram” → PDF with charts, delivered with real IDs", async () => {
    const world = new World();
    const ctx = testCtx(world.fetch);
    await connectFakeAi(ctx, research);
    await connectGoogle(ctx);
    process.env.TELEGRAM_BOT_TOKEN = "1:x";
    await saveOwner(ctx, { email: "owner@carpediem.example", telegramChatId: "42" });
    const r = await generateReport(ctx, { topic: "expansion report for Cambodia", country: "KH", language: "en" });
    expect(r.sources).toHaveLength(1);
    expect(r.html).toContain("<svg");
    expect(r.html).toContain("Cambodia expansion report");
    expect(r.pdfB64).toBeTruthy();
    expect(Buffer.from(r.pdfB64!, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    const d = await deliverReport(ctx, r.id, ["email", "telegram"]);
    expect(d.every((x) => x.ok)).toBe(true);
    expect(d[0]!.id).toBe(world.sentEmails[0]!.id);
    expect(world.sentEmails[0]!.decoded).toContain("application/pdf");
    expect(world.telegram.some((t) => t.method === "sendDocument")).toBe(true);
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("supports Russian PDFs and falls back to HTML for scripts that need shaping", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx, research);
    const ru = await generateReport(ctx, { topic: "Отчёт", language: "ru" });
    expect(ru.pdfB64).toBeTruthy();
    const hi = await generateReport(ctx, { topic: "रिपोर्ट", language: "hi" });
    expect(hi.pdfB64).toBeNull();
    expect(hi.pdfNote).toMatch(/complex text shaping/);
    const ar = await generateReport(ctx, { topic: "تقرير", language: "ar" });
    expect(ar.html).toContain('dir="rtl"');
  });

  it("reports delivery failures honestly", async () => {
    const ctx = testCtx();
    await connectFakeAi(ctx, research);
    const r = await generateReport(ctx, { topic: "x", language: "en" });
    const d = await deliverReport(ctx, r.id, ["email", "telegram"]);
    expect(d.map((x) => x.ok)).toEqual([false, false]);
    expect(d[0]!.detail).toMatch(/not connected/);
  });

  it("schedules recurring report templates", () => {
    const t = { id: "t", name: "Weekly", topic: "x", language: "en", channels: ["email" as const], schedule: { every: "week" as const, weekday: 1, hour: 9 }, enabled: true };
    expect(templateDue(t, new Date("2026-11-09T04:00:00Z"), "Asia/Kolkata")).toBe(true); // Mon 09:30 IST
    expect(templateDue({ ...t, lastRunAt: "2026-11-09T03:50:00Z" }, new Date("2026-11-09T04:00:00Z"), "Asia/Kolkata")).toBe(false);
    expect(templateDue(t, new Date("2026-11-10T04:00:00Z"), "Asia/Kolkata")).toBe(false); // Tuesday
  });
});
