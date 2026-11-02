import { z } from "zod";
import type { Ctx } from "@/core/context";
import { logActivity } from "@/core/context";
import { callJson } from "@/ai/engine";
import { authorize } from "@/core/policy";
import { getOwner } from "@/core/settings";
import { errorMessage, newId } from "@/core/util";
import { link, upsertNode } from "@/core/graph";
import { calendarFreeBusy, calendarGet, calendarInsert, googleConnected } from "@/integrations/google";
import { pushToSheet } from "@/integrations/sheets-sync";
import { createCompanyTask } from "@/integrations/tasks";
import { telegramSend } from "@/integrations/telegram";
import { languageName } from "@/lang/detect";
import { UNTRUSTED_SYSTEM_RULES, wrapUntrusted } from "@/security/untrusted";
import { COUNTRY_TIMEZONE, countryName, getLead, saveLead, setStage, type Lead } from "@/global/crm";
import { draftOutreach, messageHash, type OutreachMessage } from "@/global/outreach";
import type { InboundMessage } from "@/global/inbox";
import { findSlots, formatInZone, isValidTimeZone } from "./tz";

/**
 * INTELLIGENT MEETING COORDINATOR. Google Calendar stays the source of truth
 * for confirmed events: BINGO only marks a meeting "confirmed" when the
 * calendar shows the guest accepted.
 */
export type MeetingStatus = "proposed" | "awaiting_reply" | "time_agreed" | "invited" | "confirmed" | "declined" | "completed" | "cancelled";

export interface MeetingBrief {
  objective: string;
  previousCommunications: string;
  opportunity: string;
  documents: string[];
  questions: string[];
  commitments: string[];
  nextSteps: string[];
  generatedAt: string;
}

export interface Meeting {
  id: string;
  workspaceId: string;
  kind: "distributor" | "interview" | "supplier" | "internal" | "other";
  leadId?: string;
  contact: { name: string; email: string; company: string; country: string; timezone: string; language: string };
  objective: string;
  durationMin: number;
  status: MeetingStatus;
  proposedSlots: { start: string; end: string }[];
  agreed?: { start: string; end: string };
  calendar?: { eventId: string; htmlLink: string; meetLink?: string; attendeeStatus?: string; checkedAt?: string };
  outreachIds: string[];
  brief?: MeetingBrief;
  reminders: { kind: "24h" | "1h"; at: string; ok: boolean }[];
  followupTask?: { status: string; taskId?: string };
  notes: string[];
  createdAt: string;
}

export async function getMeeting(ctx: Ctx, id: string) {
  return ctx.store.get<Meeting>("meetings", id);
}
export async function listMeetings(ctx: Ctx) {
  return ctx.store.list<Meeting>("meetings");
}
async function save(ctx: Ctx, m: Meeting) {
  await ctx.store.put("meetings", m);
  await upsertNode(ctx, { id: `meeting:${m.id}`, kind: "meeting", label: `${m.contact.company || m.contact.name} — ${m.objective}`, data: { status: m.status, start: m.agreed?.start ?? null } });
  if (m.leadId) await link(ctx, `company:${m.leadId}`, "meeting", `meeting:${m.id}`);
  return m;
}

export async function proposeMeeting(
  ctx: Ctx,
  input: { leadId?: string; contact?: Meeting["contact"]; objective: string; durationMin?: number; kind?: Meeting["kind"]; workspaceId?: string; horizonDays?: number; workflowId?: string },
): Promise<{ meeting: Meeting; draft: OutreachMessage | null; notes: string[] }> {
  const owner = await getOwner(ctx);
  const lead = input.leadId ? await getLead(ctx, input.leadId) : null;
  const contact: Meeting["contact"] = input.contact ?? {
    name: lead?.contacts[0]?.name ?? "",
    email: lead?.emails.find((e) => e.verified)?.address ?? lead?.emails[0]?.address ?? "",
    company: lead?.company ?? "",
    country: lead?.country ?? "",
    timezone: lead?.timezone ?? COUNTRY_TIMEZONE[lead?.country ?? ""] ?? owner.timezone,
    language: lead?.language ?? "en",
  };
  if (!contact.email) throw new Error("No email address for this contact.");
  if (!isValidTimeZone(contact.timezone)) throw new Error(`Unknown time zone ${contact.timezone}`);
  const workspaceId = input.workspaceId ?? lead?.workspaceId ?? "ws_isshaan";
  if (!(await googleConnected(ctx, workspaceId))) throw new Error("Google Calendar is not connected (Settings → Connections → Google).");
  const notes: string[] = [];
  const horizon = input.horizonDays ?? 7;
  const now = ctx.now();
  const busy = await calendarFreeBusy(ctx, now, new Date(now.getTime() + (horizon + 1) * 864e5), "primary", workspaceId);
  const slots = findSlots({
    now,
    durationMin: input.durationMin ?? 30,
    horizonDays: horizon,
    minLeadHours: 18,
    owner: { timeZone: owner.timezone, start: owner.workingHours.start, end: owner.workingHours.end, days: owner.workingHours.days },
    contact: { timeZone: contact.timezone, start: "09:30", end: "18:00", days: [1, 2, 3, 4, 5] },
    busy,
    bufferMin: 15,
    maxSlots: 3,
    maxPerDay: 1,
  });
  if (!slots.length) throw new Error("No mutually convenient free slots in the next week. Try a longer horizon.");
  const meeting: Meeting = {
    id: newId("mtg"),
    workspaceId,
    kind: input.kind ?? (lead ? "distributor" : "other"),
    leadId: lead?.id,
    contact,
    objective: input.objective,
    durationMin: input.durationMin ?? 30,
    status: "proposed",
    proposedSlots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
    outreachIds: [],
    reminders: [],
    notes,
    createdAt: now.toISOString(),
  };
  // Times are formatted by code (not the model) in the contact's own time zone and language.
  const locale = contact.language || "en";
  const slotLines = slots.map((s, i) => `${i + 1}. ${formatInZone(s.start, contact.timezone, locale)} (${formatInZone(s.start, owner.timezone, "en-GB")})`).join("\n");
  let draft: OutreachMessage | null = null;
  if (lead) {
    const d = await draftOutreach(ctx, {
      leadIds: [lead.id],
      kind: "scheduling",
      language: contact.language,
      purpose: `propose a ${meeting.durationMin}-minute video call: ${input.objective}`,
      extra: `Ask them to reply with the number of the option that suits them, or suggest another time. Write the email so that the list of options can be appended at the end; do not invent times. The options will be appended after your text by the system.`,
      workflowId: input.workflowId,
    });
    draft = d.drafted[0] ?? null;
    if (draft) {
      const body = `${draft.body.split("\n\n—\n")[0]}\n\n${slotLines}\n\n—\n${draft.body.split("\n\n—\n")[1] ?? ""}`.trim();
      draft = { ...draft, body, threadId: lead.threadIds.at(-1) };
      draft.contentHash = messageHash(draft);
      await ctx.store.put("outreach", draft);
      meeting.outreachIds.push(draft.id);
      meeting.status = "awaiting_reply";
    } else notes.push(`Could not draft the scheduling email: ${d.skipped[0]?.reason ?? "unknown"}`);
    await setStage(ctx, lead, "Meeting Proposed", "bingo");
  }
  await save(ctx, meeting);
  await logActivity(ctx, { actor: "bingo", action: "meeting.proposed", summary: `Proposed ${slots.length} slots to ${contact.company || contact.name} (${languageName(locale)}, ${contact.timezone})`, workspaceId, ref: { kind: "meeting", id: meeting.id } });
  return { meeting, draft, notes };
}

const ChoiceSchema = z.object({ chosenOption: z.number(), alternativeIso: z.string(), declined: z.boolean(), explanation: z.string() });

/** Reads the contact's reply and works out which proposed slot (if any) they accepted. */
export async function interpretSchedulingReply(ctx: Ctx, meeting: Meeting, inbound: Pick<InboundMessage, "original" | "proposedTimes">) {
  const options = meeting.proposedSlots.map((s, i) => `${i + 1}. ${formatInZone(new Date(s.start), meeting.contact.timezone, "en-GB")} = ${s.start}`).join("\n");
  const numeric = inbound.original.split(/\n>|\nOn .* wrote:/)[0]!.match(/(?:option|вариант|variant|#|№)?\s*\b([1-3])\b(?![:.]\d)/i);
  const { data } = await callJson(
    ctx,
    {
      capability: "classification",
      system: `Determine which meeting option a person accepted. chosenOption: 1-based number of an option they accepted, or 0. alternativeIso: if they proposed a different time, its ISO 8601 instant with offset (use their time zone ${meeting.contact.timezone} if none stated), else "". declined: true if they declined a meeting. ${UNTRUSTED_SYSTEM_RULES}`,
      prompt: `Options offered:\n${options}\n\nTheir reply:\n${wrapUntrusted("email", inbound.original.slice(0, 4000)).block}\nTimes they mentioned: ${inbound.proposedTimes.join("; ") || "none"}`,
    },
    ChoiceSchema,
    { workspaceId: meeting.workspaceId, purpose: "meeting.interpret" },
  );
  // Cross-check the model's pick with a deterministic read of a bare option number.
  if (data.chosenOption === 0 && numeric && !data.alternativeIso && !data.declined) data.chosenOption = Number(numeric[1]);
  return data;
}

export async function handleSchedulingReply(ctx: Ctx, meetingId: string, inbound: InboundMessage) {
  const m = (await getMeeting(ctx, meetingId))!;
  const choice = await interpretSchedulingReply(ctx, m, inbound);
  if (choice.declined) {
    await save(ctx, { ...m, status: "declined", notes: [...m.notes, `Declined: ${choice.explanation}`] });
    return { status: "declined" as const };
  }
  let slot = choice.chosenOption >= 1 ? m.proposedSlots[choice.chosenOption - 1] : undefined;
  if (!slot && choice.alternativeIso && !Number.isNaN(Date.parse(choice.alternativeIso))) {
    const start = new Date(choice.alternativeIso);
    const end = new Date(start.getTime() + m.durationMin * 6e4);
    const busy = await calendarFreeBusy(ctx, start, end, "primary", m.workspaceId);
    if (busy.length) {
      await save(ctx, { ...m, notes: [...m.notes, `They proposed ${choice.alternativeIso}, but your calendar is busy then.`] });
      return { status: "conflict" as const, proposed: choice.alternativeIso };
    }
    slot = { start: start.toISOString(), end: end.toISOString() };
  }
  if (!slot) return { status: "unclear" as const, explanation: choice.explanation };
  await save(ctx, { ...m, status: "time_agreed", agreed: slot });
  return { status: "time_agreed" as const, slot };
}

/** Creates the Google Calendar event with a Meet link and sends real invitations (approval-gated). */
export async function createCalendarInvite(ctx: Ctx, meetingId: string, opts: { approvalId?: string; workflowId?: string; stepId?: string } = {}) {
  const m = (await getMeeting(ctx, meetingId))!;
  if (!m.agreed) throw new Error("No agreed time yet.");
  if (m.calendar?.eventId) return { status: "exists" as const, meeting: m };
  const owner = await getOwner(ctx);
  const payload = { meetingId: m.id, start: m.agreed.start, end: m.agreed.end, attendees: [m.contact.email] };
  const auth = await authorize(ctx, {
    kind: "calendar.event.create",
    workspaceId: m.workspaceId,
    payload,
    title: `Send calendar invitation to ${m.contact.company || m.contact.name}`,
    summary: `${formatInZone(new Date(m.agreed.start), owner.timezone)} (your time) / ${formatInZone(new Date(m.agreed.start), m.contact.timezone)} (their time)\nGuest: ${m.contact.email}\nGoogle Meet link will be added.`,
    requestedBy: "bingo",
    ...opts,
  });
  if (!auth.allowed) return { status: auth.blocked ? ("blocked" as const) : ("awaiting_approval" as const), approvalId: auth.approval?.id, reason: auth.reason, meeting: m };
  const ev = await calendarInsert(
    ctx,
    {
      summary: `${m.contact.company ? `${m.contact.company} × ` : ""}${owner.name || "Meeting"} — ${m.objective}`,
      description: `${m.objective}\n\nScheduled by BINGO.`,
      start: m.agreed.start,
      end: m.agreed.end,
      timeZone: owner.timezone,
      attendees: [{ email: m.contact.email, displayName: m.contact.name || m.contact.company }],
      withMeet: true,
      requestId: m.id,
    },
    m.workspaceId,
  );
  const meetLink = ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
  const next: Meeting = { ...m, status: "invited", calendar: { eventId: ev.id, htmlLink: ev.htmlLink, meetLink, attendeeStatus: "needsAction" } };
  if (!meetLink) next.notes.push("Google did not return a Meet link (conferencing may be disabled for this account). The invitation was still sent.");
  await save(ctx, next);
  await syncMeetingSheet(ctx, next);
  await logActivity(ctx, { actor: "bingo", action: "meeting.invited", summary: `Calendar invitation sent to ${m.contact.email} for ${formatInZone(new Date(m.agreed.start), owner.timezone)} (event ${ev.id})`, level: "success", workspaceId: m.workspaceId, ref: { kind: "meeting", id: m.id } });
  return { status: "invited" as const, meeting: next };
}

/** Scheduled: reads attendee responses from Google Calendar (authoritative). */
export async function refreshMeetingStatuses(ctx: Ctx) {
  const changed: Meeting[] = [];
  for (const m of await listMeetings(ctx)) {
    if (!m.calendar?.eventId || !["invited", "confirmed"].includes(m.status)) continue;
    try {
      const ev = await calendarGet(ctx, m.calendar.eventId, m.workspaceId);
      const status = ev.status === "cancelled" ? "cancelled" : (ev.attendees?.find((a) => a.email.toLowerCase() === m.contact.email.toLowerCase())?.responseStatus ?? "needsAction");
      const next: Meeting = { ...m, calendar: { ...m.calendar, attendeeStatus: status, checkedAt: ctx.now().toISOString() } };
      if (status === "accepted" && m.status !== "confirmed") next.status = "confirmed";
      if (status === "declined") next.status = "declined";
      if (status === "cancelled") next.status = "cancelled";
      if (next.status !== m.status) {
        await save(ctx, next);
        changed.push(next);
        await logActivity(ctx, { actor: "bingo", action: `meeting.${next.status}`, summary: `${m.contact.company || m.contact.name}: invitation ${status} (Google Calendar)`, level: next.status === "confirmed" ? "success" : "warning", workspaceId: m.workspaceId, ref: { kind: "meeting", id: m.id } });
        if (next.status === "confirmed" && m.leadId) {
          const lead = await getLead(ctx, m.leadId);
          if (lead) await setStage(ctx, lead, "Meeting Confirmed", "bingo", `event ${m.calendar.eventId}`);
          const { emitEvent } = await import("@/skills/engine");
          await emitEvent(ctx, "meeting.confirmed", { meetingId: m.id, leadId: m.leadId, company: m.contact.company, contact: m.contact.name, country: m.contact.country, start: m.agreed?.start ?? "" });
        }
        await syncMeetingSheet(ctx, next);
      } else await ctx.store.put("meetings", next);
    } catch (e) {
      await logActivity(ctx, { actor: "bingo", action: "meeting.check.error", summary: `Could not read event for ${m.contact.company}: ${errorMessage(e)}`, level: "warning" });
    }
  }
  return changed;
}

const BriefSchema = z.object({
  objective: z.string(),
  previousCommunications: z.string(),
  opportunity: z.string(),
  documents: z.array(z.string()),
  questions: z.array(z.string()),
  commitments: z.array(z.string()),
  nextSteps: z.array(z.string()),
});

export async function generateBrief(ctx: Ctx, meetingId: string): Promise<MeetingBrief> {
  const m = (await getMeeting(ctx, meetingId))!;
  const owner = await getOwner(ctx);
  const lead: Lead | null = m.leadId ? await getLead(ctx, m.leadId) : null;
  const outbound = m.leadId ? await ctx.store.list<OutreachMessage>("outreach", { where: { leadId: m.leadId } }) : [];
  const inbound = m.leadId ? await ctx.store.list<InboundMessage>("inbound", { where: { leadId: m.leadId } }) : [];
  const history = [
    ...outbound.filter((o) => o.status === "sent").map((o) => ({ at: o.sentAt ?? o.createdAt, text: `US → ${o.subject}: ${o.body.slice(0, 600)}` })),
    ...inbound.map((i) => ({ at: i.receivedAt, text: `THEM (${i.intent}): ${i.translation ?? i.original.slice(0, 600)}` })),
  ]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((h) => `[${h.at.slice(0, 10)}] ${h.text}`)
    .join("\n");
  const { data } = await callJson(
    ctx,
    {
      capability: "reasoning",
      system: `Prepare a concise meeting brief in ${languageName(owner.preferredLanguage)} for a business owner. Use only the facts given. Commitments: list only promises actually made in the history. ${UNTRUSTED_SYSTEM_RULES}`,
      prompt: `Meeting: ${m.objective} with ${m.contact.name || "(name unknown)"} of ${m.contact.company} (${countryName(m.contact.country)}).\nWhen: ${m.agreed ? formatInZone(new Date(m.agreed.start), owner.timezone) : "not fixed"}\nCRM: stage ${lead?.stage ?? "-"}, relevance ${lead?.relevance ?? "-"}, ${lead?.portfolioFit ?? ""}\nCompany profile:\n${wrapUntrusted("crm", lead?.description ?? "").block}\nCommunication history:\n${wrapUntrusted("emails", history || "none").block}`,
      effort: "medium",
    },
    BriefSchema,
    { workspaceId: m.workspaceId, purpose: "meeting.brief" },
  );
  const brief: MeetingBrief = { ...data, generatedAt: ctx.now().toISOString() };
  await save(ctx, { ...m, brief });
  return brief;
}

/** Scheduled: briefings/reminders before meetings and follow-up tasks after. */
export async function meetingReminders(ctx: Ctx) {
  const owner = await getOwner(ctx);
  const now = ctx.now().getTime();
  for (const m of await listMeetings(ctx)) {
    if (!m.agreed || !["invited", "confirmed"].includes(m.status)) continue;
    const start = new Date(m.agreed.start).getTime();
    const end = new Date(m.agreed.end).getTime();
    for (const [kind, before] of [["24h", 24 * 36e5], ["1h", 36e5]] as const) {
      if (now >= start - before && now < start && !m.reminders.some((r) => r.kind === kind)) {
        let brief = m.brief;
        if (!brief) brief = await generateBrief(ctx, m.id).catch(() => undefined);
        const text = `📅 <b>${kind === "1h" ? "In 1 hour" : "Tomorrow"}:</b> ${m.contact.company || m.contact.name} — ${m.objective}\n${formatInZone(new Date(m.agreed.start), owner.timezone)}${m.calendar?.meetLink ? `\n${m.calendar.meetLink}` : ""}${brief ? `\n\n<b>Objective:</b> ${brief.objective}\n<b>Ask:</b> ${brief.questions.slice(0, 4).join(" · ")}\n<b>Open commitments:</b> ${brief.commitments.join(" · ") || "none"}` : ""}`;
        const r = await telegramSend(ctx, text).catch((e) => ({ skipped: errorMessage(e) }));
        const fresh = (await getMeeting(ctx, m.id))!;
        await save(ctx, { ...fresh, reminders: [...fresh.reminders, { kind, at: ctx.now().toISOString(), ok: "messageId" in r }] });
      }
    }
    if (now > end + 30 * 6e4 && !m.followupTask) {
      const r = await createCompanyTask(
        ctx,
        {
          ref: `meeting:${m.id}:followup`,
          kind: m.kind === "interview" ? "interview_prep" : "meeting_followup",
          title: `Follow up after meeting with ${m.contact.company || m.contact.name}`,
          details: `Meeting: ${m.objective} (${m.agreed.start}). Record outcome and next steps in BINGO → Global.${m.brief ? `\nSuggested next steps: ${m.brief.nextSteps.join("; ")}` : ""}`,
          deadline: new Date(now + 2 * 864e5),
          level: 2,
        },
        "bingo",
        m.workspaceId,
      );
      const fresh = (await getMeeting(ctx, m.id))!;
      await save(ctx, { ...fresh, status: "completed", followupTask: { status: r.status, taskId: "taskId" in r ? r.taskId : undefined } });
    }
  }
}

/** Scheduled: takes meeting requests found in replies and moves them forward. */
export async function processSchedulingQueue(ctx: Ctx) {
  const queue = await ctx.store.list<{ id: string; leadId: string; inboundId: string }>("scheduling_queue");
  for (const q of queue) {
    try {
      const existing = (await listMeetings(ctx)).find((m) => m.leadId === q.leadId && ["awaiting_reply", "proposed"].includes(m.status));
      const inbound = await ctx.store.get<InboundMessage>("inbound", q.inboundId);
      if (existing && inbound) {
        const r = await handleSchedulingReply(ctx, existing.id, inbound);
        if (r.status === "time_agreed") await createCalendarInvite(ctx, existing.id);
      } else if (!existing) {
        const lead = await getLead(ctx, q.leadId);
        if (lead) await proposeMeeting(ctx, { leadId: lead.id, objective: "Introductory call about distribution partnership" });
      }
      await ctx.store.delete("scheduling_queue", q.id);
    } catch (e) {
      await logActivity(ctx, { actor: "bingo", action: "meeting.queue.error", summary: errorMessage(e), level: "warning" });
    }
  }
}

async function syncMeetingSheet(ctx: Ctx, m: Meeting) {
  const owner = await getOwner(ctx);
  await pushToSheet(ctx, "meetings", [
    {
      "BINGO ID": m.id,
      Contact: m.contact.name || m.contact.email,
      Company: m.contact.company,
      Country: m.contact.country,
      "Start (owner time)": m.agreed ? formatInZone(new Date(m.agreed.start), owner.timezone) : "",
      "Start (contact time)": m.agreed ? formatInZone(new Date(m.agreed.start), m.contact.timezone) : "",
      Status: m.status,
      "Calendar Event": m.calendar?.htmlLink ?? "",
      "Meet Link": m.calendar?.meetLink ?? "",
      Objective: m.objective,
      "Next Steps": m.brief?.nextSteps.join("; ") ?? "",
    },
  ]);
}

export { saveLead };
