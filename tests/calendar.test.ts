import { afterEach, describe, expect, it } from "vitest";
import { setAdapterFactory } from "@/ai/engine";
import { decideApproval, savePolicy } from "@/core/policy";
import { saveOwner } from "@/core/settings";
import { createCalendarInvite, getMeeting, listMeetings, meetingReminders, processSchedulingQueue, proposeMeeting, refreshMeetingStatuses } from "@/calendar/meetings";
import { findSlots, offsetMinutes, zonedParts, zonedToUtc } from "@/calendar/tz";
import { getLead, listLeads } from "@/global/crm";
import { pollReplies } from "@/global/inbox";
import { draftOutreach, listOutreach, requestSendApproval, sendApproved } from "@/global/outreach";
import { researchDistributors } from "@/global/research";
import { learnSkill } from "@/skills/engine";
import { saveTaskConfig } from "@/integrations/tasks";
import { saveSheetLink } from "@/integrations/sheets-sync";
import { connectFakeAi } from "./fakes/ai";
import { connectGoogle, UZ_RESEARCH, uzWorld } from "./fixtures";
import { testCtx } from "./helpers";

afterEach(() => setAdapterFactory(null));

describe("time zones", () => {
  it("uses the IANA database for offsets and wall-clock conversion", () => {
    const d = new Date("2026-11-10T06:00:00Z");
    expect(offsetMinutes(d, "Asia/Kolkata")).toBe(330);
    expect(offsetMinutes(d, "Asia/Tashkent")).toBe(300);
    expect(offsetMinutes(d, "Asia/Kathmandu")).toBe(345);
    expect(zonedToUtc(2026, 11, 10, 11, 30, "Asia/Kolkata").toISOString()).toBe("2026-11-10T06:00:00.000Z");
    // DST: New York 2026-03-08 jumps from EST to EDT.
    expect(zonedToUtc(2026, 3, 9, 9, 0, "America/New_York").toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("finds slots inside both people's working hours and avoids busy time", () => {
    const now = new Date("2026-11-09T04:00:00Z"); // Monday 09:30 IST
    const slots = findSlots({
      now,
      durationMin: 30,
      horizonDays: 5,
      minLeadHours: 18,
      owner: { timeZone: "Asia/Kolkata", start: "10:00", end: "19:00", days: [1, 2, 3, 4, 5, 6] },
      contact: { timeZone: "Asia/Tashkent", start: "09:30", end: "18:00", days: [1, 2, 3, 4, 5] },
      busy: [{ start: "2026-11-10T04:30:00Z", end: "2026-11-10T06:00:00Z" }],
      bufferMin: 15,
      maxSlots: 3,
      maxPerDay: 1,
    });
    expect(slots).toHaveLength(3);
    for (const s of slots) {
      const o = zonedParts(s.start, "Asia/Kolkata");
      const c = zonedParts(s.start, "Asia/Tashkent");
      expect(o.hour * 60 + o.minute).toBeGreaterThanOrEqual(600);
      expect(c.hour * 60 + c.minute).toBeGreaterThanOrEqual(570);
      expect(c.weekday).toBeLessThanOrEqual(5);
      expect(s.start.getTime() >= new Date("2026-11-10T06:15:00Z").getTime() || s.end.getTime() <= new Date("2026-11-10T04:15:00Z").getTime()).toBe(true);
    }
    expect(new Set(slots.map((s) => zonedParts(s.start, "Asia/Kolkata").day)).size).toBe(3);
  });
});

describe("meeting coordinator (acceptance test 3)", () => {
  it("distributor agrees → slots in their zone → reply picks one → approved Calendar invite with Meet → acceptance from Google → CRM + follow-up task", async () => {
    const world = uzWorld();
    const now = new Date("2026-11-09T04:00:00Z");
    const ctx = testCtx(world.fetch, () => new Date(now));
    await connectFakeAi(ctx, UZ_RESEARCH);
    await connectGoogle(ctx);
    await saveOwner(ctx, { name: "Aryan Satyam", email: "owner@carpediem.example", preferredLanguage: "en", timezone: "Asia/Kolkata" });
    await saveSheetLink(ctx, { id: "meetings", spreadsheetId: "s1", tab: "Meetings" });
    await savePolicy(ctx, "global", { limits: { minSecondsBetweenEmails: 0, initialEmailsPerDay: 10, initialEmailsPerDomainPerDay: 2, previewDeploysPerDay: 5, callsPerDay: 2 } });
    await researchDistributors(ctx, { workspaceId: "ws_carpediem", country: "UZ", count: 5, segment: "pharma" });
    const lead = (await listLeads(ctx)).find((l) => l.company.startsWith("PharmaUz"))!;
    const d = await draftOutreach(ctx, { leadIds: [lead.id], language: "ru" });
    const a1 = await requestSendApproval(ctx, d.drafted.map((m) => m.id));
    await decideApproval(ctx, a1.approvalId!, "approved", "test");
    await requestSendApproval(ctx, d.drafted.map((m) => m.id), { approvalId: a1.approvalId });
    await sendApproved(ctx);
    const thread = world.sentEmails[0]!.threadId;

    // The distributor agrees to meet.
    world.reply(thread, "Rustam <info@pharmauz.example>", "Здравствуйте! Да, давайте созвонимся на следующей неделе.");
    world.busy = [{ start: "2026-11-10T05:00:00Z", end: "2026-11-10T07:00:00Z" }];
    await pollReplies(ctx);
    await processSchedulingQueue(ctx);
    const [meeting] = await listMeetings(ctx);
    expect(meeting!.status).toBe("awaiting_reply");
    expect(meeting!.contact.timezone).toBe("Asia/Tashkent");
    expect(meeting!.proposedSlots).toHaveLength(3);
    const schedulingEmail = (await listOutreach(ctx, { leadId: lead.id })).find((m) => m.kind === "scheduling")!;
    expect(schedulingEmail.body).toMatch(/1\. .*GMT\+5/); // times shown in Tashkent time, formatted by code
    expect(schedulingEmail.threadId).toBe(thread);
    expect((await getLead(ctx, lead.id))!.stage).toBe("Meeting Proposed");

    // Owner approves the scheduling email; it is sent in the same thread.
    const a2 = await requestSendApproval(ctx, [schedulingEmail.id]);
    await decideApproval(ctx, a2.approvalId!, "approved", "test");
    await requestSendApproval(ctx, [schedulingEmail.id], { approvalId: a2.approvalId });
    await sendApproved(ctx);
    expect(world.sentEmails.at(-1)!.threadId).toBe(thread);

    // They pick option 2.
    world.reply(thread, "Rustam <info@pharmauz.example>", "Нам подходит вариант 2. Спасибо!");
    await pollReplies(ctx);
    await processSchedulingQueue(ctx);
    let m = (await getMeeting(ctx, meeting!.id))!;
    expect(m.status).toBe("time_agreed");
    expect(m.agreed).toEqual(m.proposedSlots[1]);
    expect(world.events.size).toBe(0); // invitation needs approval first

    const inv = await createCalendarInvite(ctx, m.id);
    expect(inv.status).toBe("awaiting_approval");
    await decideApproval(ctx, inv.approvalId!, "approved", "test");
    const sent = await createCalendarInvite(ctx, m.id, { approvalId: inv.approvalId });
    expect(sent.status).toBe("invited");
    const ev = [...world.events.values()][0]!;
    expect(ev.attendees[0]!.email).toBe("info@pharmauz.example");
    expect(world.requests.find((r) => r.url.includes("/events?"))!.url).toContain("sendUpdates=all");
    m = (await getMeeting(ctx, m.id))!;
    expect(m.calendar?.meetLink).toMatch(/meet.google.com/);
    expect(m.status).toBe("invited"); // not "confirmed" until Google says so

    // Skill: follow-up task when a meeting is confirmed (company task sheet).
    await saveTaskConfig(ctx, { apiUrl: "https://script.google.com/macros/s/fake/exec", loginId: "bingo", routing: { default: "Aryan Satyam" }, defaultLevel: 2 }, "pw");
    await learnSkill(ctx, "Whenever a distributor meeting is confirmed, create a follow-up task in my existing company Google Sheet.");

    ev.attendees[0]!.responseStatus = "accepted";
    const changed = await refreshMeetingStatuses(ctx);
    expect(changed[0]!.status).toBe("confirmed");
    expect((await getLead(ctx, lead.id))!.stage).toBe("Meeting Confirmed");
    const wfs = await ctx.store.list<{ goal: string; steps: { type: string; params: Record<string, unknown> }[] }>("workflows");
    expect(wfs[0]!.steps[0]!.type).toBe("tasks.create");
    expect(String(wfs[0]!.steps[0]!.params.title)).toContain("PharmaUz Distribution LLC");

    // Meetings are recorded in the linked Google Sheet (status from Google Calendar).
    const rows = world.sheets.get("Meetings")!;
    expect(rows[0]).toContain("Meet Link");
    expect(rows[1]).toContain("confirmed");

    // Reminder with brief 24h before.
    (ctx as { now: () => Date }).now = () => new Date(new Date(m.agreed!.start).getTime() - 23 * 36e5);
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    await saveOwner(ctx, { telegramChatId: "42" });
    await meetingReminders(ctx);
    const tg = world.telegram.find((x) => x.method === "sendMessage")!;
    expect(JSON.stringify(tg.body)).toContain("Tomorrow");
    expect(JSON.stringify(tg.body)).toContain("Which channels?");
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("fails clearly when Google Calendar is not connected", async () => {
    const ctx = testCtx();
    await expect(proposeMeeting(ctx, { contact: { name: "A", email: "a@b.c", company: "B", country: "UZ", timezone: "Asia/Tashkent", language: "ru" }, objective: "x" })).rejects.toThrow(/Google Calendar is not connected/);
  });
});
