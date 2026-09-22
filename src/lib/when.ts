/**
 * Plain-language timing ("tomorrow", "Friday", "next week", "in 2 days", "25 Sep", "within 24 hours") to a moment.
 * Days land at the team's morning (10:00 India) unless the words carry a time. Pure: pass `now` in tests.
 */
export const TEAM_TZ = "Asia/Kolkata";
export const MORNING_HOUR = 10;

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The calendar parts of an instant in the team's time zone. */
export function teamParts(d: Date): { y: number; m: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TEAM_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { y: Number(g("year")), m: Number(g("month")), day: Number(g("day")), hour: Number(g("hour")), minute: Number(g("minute")), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")) };
}

/** The instant of a team-zone calendar time. India has no daylight saving: a fixed +05:30. */
export function teamTime(y: number, m: number, day: number, hour = MORNING_HOUR, minute = 0): Date {
  return new Date(Date.UTC(y, m - 1, day, hour, minute) - 5.5 * 3_600_000);
}

/** Today's date in the team zone plus `days`, at the morning hour (or the given hour). */
export function daysFromNow(now: Date, days: number, hour = MORNING_HOUR, minute = 0): Date {
  const p = teamParts(now);
  return teamTime(p.y, p.m, p.day + days, hour, minute);
}

export function parseWhen(text: string | null | undefined, now = new Date()): Date | null {
  if (!text) return null;
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;
  const p = teamParts(now);
  const timeIn = t.match(/\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  let hour = MORNING_HOUR, minute = 0;
  if (timeIn) { hour = Number(timeIn[1]); minute = Number(timeIn[2] ?? 0); if (timeIn[3] === "pm" && hour < 12) hour += 12; if (timeIn[3] === "am" && hour === 12) hour = 0; }
  if (/\b(end of (the )?day|eod|tonight|this evening)\b/.test(t)) { hour = 18; minute = 0; }

  // "within 24 hours", "in 2 hours", "in 30 minutes": from now, not from the morning.
  const hrs = t.match(/\b(?:in|within)\s+(\d+)\s*(hours?|hrs?)\b/);
  if (hrs) return new Date(now.getTime() + Number(hrs[1]) * 3_600_000);
  const mins = t.match(/\b(?:in|within)\s+(\d+)\s*(minutes?|mins?)\b/);
  if (mins) return new Date(now.getTime() + Number(mins[1]) * 60_000);

  if (/\b(now|right away|immediately|asap)\b/.test(t)) return now;
  if (/\btoday\b/.test(t)) { const d = teamTime(p.y, p.m, p.day, hour, minute); return d > now ? d : new Date(now.getTime() + 3_600_000); }
  if (/\bday after tomorrow\b/.test(t)) return teamTime(p.y, p.m, p.day + 2, hour, minute);
  if (/\btomorrow\b/.test(t)) return teamTime(p.y, p.m, p.day + 1, hour, minute);
  const inDays = t.match(/\b(?:in|within|after)\s+(\d+|a|one|two|three|four|five|six|seven)\s*(days?|working days?|business days?)\b/);
  if (inDays) {
    const n = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 }[inDays[1]] ?? Number(inDays[1]);
    return /working|business/.test(inDays[2]) ? addWorkingDaysTeam(now, n, hour, minute) : teamTime(p.y, p.m, p.day + n, hour, minute);
  }
  const inWeeks = t.match(/\b(?:in|within|after)\s+(\d+|a|one|two)\s*weeks?\b/);
  if (inWeeks) { const n = { a: 1, one: 1, two: 2 }[inWeeks[1]] ?? Number(inWeeks[1]); return teamTime(p.y, p.m, p.day + 7 * n, hour, minute); }
  if (/\bnext week\b/.test(t)) return teamTime(p.y, p.m, p.day + ((8 - p.weekday) % 7 || 7), hour, minute); // next Monday
  if (/\b(this|end of (the )?) ?week\b|\bby friday\b/.test(t) && !/\bnext\b/.test(t)) { const toFri = (5 - p.weekday + 7) % 7; return teamTime(p.y, p.m, p.day + (toFri === 0 && p.weekday === 5 ? 0 : toFri), hour, minute); }
  if (/\bnext month\b/.test(t)) return teamTime(p.y, p.m + 1, 1, hour, minute);
  if (/\bend of (the )?month\b/.test(t)) return teamTime(p.y, p.m + 1, 0, hour, minute);

  // Weekday names: "Friday", "next Monday", "on Tuesday". Always ahead of now.
  for (let i = 0; i < 7; i++) {
    const re = new RegExp(`\\b(next\\s+)?${DAYS[i]}\\b|\\b(next\\s+)?${DAYS[i].slice(0, 3)}\\b`);
    const m = re.exec(t);
    if (m) {
      let ahead = (i - p.weekday + 7) % 7;
      if (ahead === 0) ahead = 7;
      if ((m[1] || m[2]) && ahead < 7 && i <= p.weekday) ahead += 0; // "next Monday" said on a Wednesday is the coming Monday, same as "Monday"
      return teamTime(p.y, p.m, p.day + ahead, hour, minute);
    }
  }

  // Dates: "25 Sep", "25th September", "Sep 25", "25/09", "25/09/2026", "2026-09-25".
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return teamTime(Number(iso[1]), Number(iso[2]), Number(iso[3]), hour, minute);
  const dmy = t.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/);
  if (dmy) { const y = dmy[3] ? (dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3])) : p.y; const d = teamTime(y, Number(dmy[2]), Number(dmy[1]), hour, minute); return !dmy[3] && d < now ? teamTime(y + 1, Number(dmy[2]), Number(dmy[1]), hour, minute) : d; }
  const dm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?\b/) ?? (() => { const r = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/); return r ? [r[0], r[2], r[1], r[3]] as RegExpMatchArray : null; })();
  if (dm) { const y = dm[3] ? Number(dm[3]) : p.y; const d = teamTime(y, MONTHS.indexOf(dm[2]) + 1, Number(dm[1]), hour, minute); return !dm[3] && d < now ? teamTime(y + 1, MONTHS.indexOf(dm[2]) + 1, Number(dm[1]), hour, minute) : d; }
  return null;
}

function addWorkingDaysTeam(now: Date, n: number, hour: number, minute: number): Date {
  const p = teamParts(now);
  let day = p.day, left = n, wd = p.weekday;
  while (left > 0) { day++; wd = (wd + 1) % 7; if (wd !== 0 && wd !== 6) left--; }
  return teamTime(p.y, p.m, day, hour, minute);
}

/** "Thu 25 Sep" / "Thu 25 Sep 16:00" in the team zone, for feed lines and card labels. */
export function whenLabel(d: Date, withTime = false): string {
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TEAM_TZ });
  if (!withTime) return day;
  const p = teamParts(d);
  return p.hour === MORNING_HOUR && p.minute === 0 ? day : `${day} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** True during the team's morning minute (10:00 India), when daily repeats go out. */
export function isMorningMinute(now = new Date()): boolean {
  const p = teamParts(now);
  return p.hour === MORNING_HOUR && p.minute === 0;
}
