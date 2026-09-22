import { describe, it, expect } from "vitest";
import { parseWhen, teamParts, whenLabel, teamTime } from "../src/lib/when";

// Tuesday 22 Sep 2026, 14:05 India (08:35 UTC)
const now = new Date("2026-09-22T08:35:00Z");
const ist = (d: Date | null) => (d ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][teamParts(d).weekday]} ${teamParts(d).day} ${String(teamParts(d).hour).padStart(2, "0")}:${String(teamParts(d).minute).padStart(2, "0")}` : null);

describe("plain-language timing, India time, mornings at 10:00", () => {
  it("tomorrow, day after, in N days", () => {
    expect(ist(parseWhen("remind me tomorrow", now))).toBe("Wed 23 10:00");
    expect(ist(parseWhen("day after tomorrow", now))).toBe("Thu 24 10:00");
    expect(ist(parseWhen("in 2 days", now))).toBe("Thu 24 10:00");
    expect(ist(parseWhen("in three working days", now))).toBe("Fri 25 10:00");
  });
  it("weekdays are always ahead; next week is Monday", () => {
    expect(ist(parseWhen("chase on Friday", now))).toBe("Fri 25 10:00");
    expect(ist(parseWhen("Tuesday", now))).toBe("Tue 29 10:00");
    expect(ist(parseWhen("next week", now))).toBe("Mon 28 10:00");
    expect(ist(parseWhen("by friday", now))).toBe("Fri 25 10:00");
  });
  it("hours and minutes count from now; a time of day is kept", () => {
    expect(parseWhen("within 24 hours", now)?.toISOString()).toBe("2026-09-23T08:35:00.000Z");
    expect(parseWhen("in 30 minutes", now)?.toISOString()).toBe("2026-09-22T09:05:00.000Z");
    expect(ist(parseWhen("tomorrow at 4pm", now))).toBe("Wed 23 16:00");
    expect(ist(parseWhen("today end of day", now))).toBe("Tue 22 18:00");
  });
  it("dates in the usual shapes, rolling to next year when past", () => {
    expect(ist(parseWhen("25 Sep", now))).toBe("Fri 25 10:00");
    expect(ist(parseWhen("Sep 30", now))).toBe("Wed 30 10:00");
    expect(ist(parseWhen("01/10", now))).toBe("Thu 1 10:00");
    expect(teamParts(parseWhen("5 Jan", now)!).y).toBe(2027);
    expect(parseWhen("2026-10-05", now)?.toISOString()).toBe("2026-10-05T04:30:00.000Z");
  });
  it("nothing recognisable is null, never a guess", () => {
    expect(parseWhen("when you can", now)).toBeNull();
    expect(parseWhen("", now)).toBeNull();
    expect(parseWhen(null, now)).toBeNull();
  });
  it("labels read like the team says them", () => {
    expect(whenLabel(teamTime(2026, 9, 25))).toBe("Fri 25 Sept");
    expect(whenLabel(teamTime(2026, 9, 25, 16, 0), true)).toBe("Fri 25 Sept 16:00");
    expect(whenLabel(teamTime(2026, 9, 25), true)).toBe("Fri 25 Sept");
  });
});
