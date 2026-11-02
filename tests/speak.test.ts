import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { saveOwner } from "@/core/settings";
import { DEFAULT_ESCALATION, acknowledge, applyPolicyInstruction, decide, decideChannels, escalate, followUpIncidents, getEscalationPolicy, saveEscalationPolicy, type Incident } from "@/speak/escalation";
import { menuTwiml, validTwilioSignature } from "@/speak/telephony";
import { World } from "./fakes/world";
import { testCtx } from "./helpers";

const base = { now: new Date("2026-11-10T08:00:00Z"), timezone: "Asia/Kolkata", verified: true, callsToday: 0, callsThisIncident: 0, callSpendThisMonth: 0, telephony: true };

describe("escalation policy", () => {
  it("“Call me immediately for all major business emergencies, but send routine matters to Telegram.”", () => {
    const { policy, changes } = applyPolicyInstruction(DEFAULT_ESCALATION, "BINGO, call me immediately for all major business emergencies, but send routine matters to Telegram.", new Date());
    expect(policy.channels.CRITICAL).toContain("call");
    expect(policy.channels.LOW).toContain("telegram");
    expect(policy.channels.MEDIUM).toEqual(["activity", "telegram"]);
    expect(changes).toHaveLength(2);
    expect(policy.history.at(-1)!.instruction).toMatch(/emergencies/);
  });

  it("understands quiet hours, DND, VIPs, call limits and budget", () => {
    let p = DEFAULT_ESCALATION;
    const now = new Date("2026-11-10T08:00:00Z");
    p = applyPolicyInstruction(p, "Don't call me between 11pm and 6:30am", now).policy;
    expect(p.quietHours).toMatchObject({ start: "23:00", end: "06:30" });
    p = applyPolicyInstruction(p, "Do not disturb me for 2 hours", now).policy;
    expect(p.dndUntil).toBe("2026-11-10T10:00:00.000Z");
    p = applyPolicyInstruction(p, "Treat pharmauz.example as VIP", now).policy;
    expect(p.vip[0]!.match).toBe("pharmauz.example");
    p = applyPolicyInstruction(p, "No more than 3 calls per day and a call budget of $10", now).policy;
    expect(p.maxCallsPerDay).toBe(3);
    expect(p.monthlyCallBudgetUsd).toBe(10);
  });

  it("does not call for small things, during quiet hours, without verification, or over limits", () => {
    const p = DEFAULT_ESCALATION;
    expect(decideChannels(p, "LOW", base).channels).toEqual(["activity"]);
    expect(decideChannels(p, "MEDIUM", base).channels).toEqual(["activity", "telegram"]);
    expect(decideChannels(p, "CRITICAL", base).channels).toContain("call");
    const night = { ...base, now: new Date("2026-11-10T18:30:00Z") }; // 00:00 IST
    expect(decideChannels(p, "HIGH", night).suppressed.map((s) => s.channel)).toContain("telegram");
    expect(decideChannels(p, "CRITICAL", night).channels).toContain("call"); // critical allowed in quiet hours
    expect(decideChannels({ ...p, quietHours: { ...p.quietHours, allowCritical: false } }, "CRITICAL", night).channels).not.toContain("call");
    expect(decideChannels(p, "CRITICAL", { ...base, verified: false }).suppressed[0]!.reason).toMatch(/not verified/);
    expect(decideChannels(p, "CRITICAL", { ...base, callsThisIncident: 2 }).suppressed[0]!.reason).toMatch(/Repeat-call/);
    expect(decideChannels(p, "CRITICAL", { ...base, callsToday: 4 }).suppressed[0]!.reason).toMatch(/Daily/);
    expect(decideChannels(p, "CRITICAL", { ...base, callSpendThisMonth: 25 }).suppressed[0]!.reason).toMatch(/budget/);
    expect(decideChannels(p, "CRITICAL", { ...base, telephony: false }).channels).toContain("telegram");
    expect(decideChannels({ ...p, dndUntil: "2026-11-10T09:00:00Z" }, "MEDIUM", base).channels).toEqual(["activity"]);
  });
});

describe("BINGO PRIORITY CALL (acceptance test 4)", () => {
  async function setup() {
    const world = new World();
    const ctx = testCtx(world.fetch, () => new Date("2026-11-10T08:00:00Z"));
    await saveOwner(ctx, { phone: "+919800000000", telegramChatId: "42", timezone: "Asia/Kolkata" });
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    await ctx.vault.setJson("global", "telephony", { provider: "twilio", accountSid: "AC123", authToken: "tok", from: "+15550001111", language: "en-IN" });
    const p = applyPolicyInstruction(await getEscalationPolicy(ctx), "Call me immediately for all major business emergencies, but send routine matters to Telegram.", ctx.now()).policy;
    await saveEscalationPolicy(ctx, p);
    return { world, ctx };
  }
  const exclusivity = {
    category: "exclusivity_request",
    title: "PharmaUz requests exclusive distribution for Uzbekistan",
    summary: "They want 5-year exclusivity for all products.",
    details: "…",
    options: [{ label: "Decline politely", description: "" }, { label: "Discuss on a call", description: "" }],
    recommendation: "Do not commit; offer a call.",
    source: { kind: "inbound", id: "in1" },
    verified: true,
  };

  it("HIGH commercial request → Telegram with options, no phone call; decision is recorded, nothing is committed", async () => {
    const { world, ctx } = await setup();
    const inc = await escalate(ctx, exclusivity);
    expect(inc.severity).toBe("HIGH");
    expect(world.calls).toHaveLength(0);
    const tg = world.telegram.find((t) => t.method === "sendMessage")!;
    expect(JSON.stringify(tg.body)).toContain("Decline politely");
    const decided = await decide(ctx, inc.id, 1, "telegram");
    expect(decided).toMatchObject({ status: "resolved", decision: { option: "Discuss on a call" } });
    // Same source does not create a second incident.
    expect((await escalate(ctx, exclusivity)).id).not.toBe(inc.id); // first one resolved → new allowed
  });

  it("CRITICAL verified incident → a real Twilio call with a professional script; follow-up if not acknowledged", async () => {
    const { world, ctx } = await setup();
    const inc = await escalate(ctx, { ...exclusivity, category: "contract_commitment", severity: "CRITICAL", title: "A distributor demands a signed exclusivity commitment by 5pm today", source: { kind: "inbound", id: "in2" } });
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]!.to).toBe("+919800000000");
    expect(world.calls[0]!.twiml).toContain("Hello, this is BINGO, your AI business assistant.");
    expect(world.calls[0]!.twiml).toContain("Would you like a quick summary?");
    expect(inc.calls[0]!.sid).toBe(world.calls[0]!.sid);
    // Not acknowledged → after the timeout BINGO calls once more (repeat limit 2), then stops calling.
    (ctx as { now: () => Date }).now = () => new Date("2026-11-10T08:11:00Z");
    await followUpIncidents(ctx);
    expect(world.calls).toHaveLength(2);
    (ctx as { now: () => Date }).now = () => new Date("2026-11-10T08:22:00Z");
    await followUpIncidents(ctx);
    expect(world.calls).toHaveLength(2);
    const after = (await ctx.store.get<Incident>("incidents", inc.id))!;
    expect(after.deliveries.some((d) => d.detail.includes("Repeat-call limit"))).toBe(true);
    const twiml = await menuTwiml(ctx, after, { digits: "1" });
    expect(twiml).toContain("I will not commit to anything without your written approval");
    await acknowledge(ctx, inc.id, "phone");
    expect((await ctx.store.get<Incident>("incidents", inc.id))!.status).toBe("acknowledged");
  });

  it("does not call when the incident is unverified", async () => {
    const { world, ctx } = await setup();
    await escalate(ctx, { ...exclusivity, severity: "CRITICAL", verified: false, source: { kind: "x", id: "3" } });
    expect(world.calls).toHaveLength(0);
    expect(world.telegram.length).toBeGreaterThan(0);
  });

  it("validates Twilio webhook signatures", () => {
    const params = { CallSid: "CA1", Digits: "1" };
    const url = "https://bingo.example/api/webhooks/twilio/voice?incident=inc_1";
    const sig = createHmac("sha1", "tok").update(url + "CallSidCA1Digits1").digest("base64");
    expect(validTwilioSignature("tok", url, params, sig)).toBe(true);
    expect(validTwilioSignature("tok", url, { ...params, Digits: "2" }, sig)).toBe(false);
  });
});
