/** Time-zone maths with the platform's Intl database only (no hard-coded offsets). */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 1=Mon … 7=Sun
}

const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: WD[get("weekday")]! };
}

/** Offset of a zone from UTC at an instant, in minutes (e.g. +330 for Asia/Kolkata). */
export function offsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

/** Wall-clock time in a zone → instant. Handles DST by re-checking the offset. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let off = offsetMinutes(new Date(guess), timeZone);
  let t = guess - off * 60000;
  const off2 = offsetMinutes(new Date(t), timeZone);
  if (off2 !== off) {
    off = off2;
    t = guess - off * 60000;
  }
  return new Date(t);
}

export function formatInZone(date: Date, timeZone: string, locale = "en-GB", withZone = true) {
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...(withZone ? { timeZoneName: "short" } : {}) }).format(date);
}

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number) as [number, number];
  return h * 60 + (m || 0);
};

export interface SlotQuery {
  now: Date;
  durationMin: number;
  horizonDays: number;
  minLeadHours: number;
  owner: { timeZone: string; start: string; end: string; days: number[] };
  contact: { timeZone: string; start: string; end: string; days: number[] };
  busy: { start: string; end: string }[];
  bufferMin: number;
  maxSlots: number;
  maxPerDay: number;
}

/** Finds mutually convenient slots in both people's working hours, avoiding busy times. */
export function findSlots(q: SlotQuery): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  const busy = q.busy.map((b) => [new Date(b.start).getTime() - q.bufferMin * 6e4, new Date(b.end).getTime() + q.bufferMin * 6e4] as const);
  const earliest = q.now.getTime() + q.minLeadHours * 36e5;
  const startDay = zonedParts(q.now, q.owner.timeZone);
  for (let dayOffset = 0; dayOffset <= q.horizonDays && out.length < q.maxSlots; dayOffset++) {
    const base = new Date(Date.UTC(startDay.year, startDay.month - 1, startDay.day + dayOffset));
    const y = base.getUTCFullYear();
    const m = base.getUTCMonth() + 1;
    const d = base.getUTCDate();
    let perDay = 0;
    for (let mins = hm(q.owner.start); mins + q.durationMin <= hm(q.owner.end) && perDay < q.maxPerDay; mins += 30) {
      const start = zonedToUtc(y, m, d, Math.floor(mins / 60), mins % 60, q.owner.timeZone);
      const end = new Date(start.getTime() + q.durationMin * 6e4);
      if (start.getTime() < earliest) continue;
      const op = zonedParts(start, q.owner.timeZone);
      if (!q.owner.days.includes(op.weekday)) break;
      const cs = zonedParts(start, q.contact.timeZone);
      const ce = zonedParts(end, q.contact.timeZone);
      const cStart = cs.hour * 60 + cs.minute;
      const cEnd = ce.hour * 60 + ce.minute || 24 * 60;
      if (!q.contact.days.includes(cs.weekday) || cStart < hm(q.contact.start) || cEnd > hm(q.contact.end) || ce.day !== cs.day) continue;
      if (busy.some(([bs, be]) => start.getTime() < be && end.getTime() > bs)) continue;
      out.push({ start, end });
      perDay++;
      mins += 90; // spread options across the day
    }
  }
  return out.slice(0, q.maxSlots);
}
