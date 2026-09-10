import { describe, it, expect } from "vitest";
import { meetingTitle, heldAtFrom } from "../src/lib/meet";

describe("meeting notes", () => {
  it("strips the Gemini suffix from the doc name", () => {
    expect(meetingTitle("HOH monthly review - Notes by Gemini")).toBe("HOH monthly review");
    expect(meetingTitle("Team standup – Notes by Gemini")).toBe("Team standup");
  });
  it("reads the meeting date from the notes head", () => {
    expect(heldAtFrom("HOH monthly review\nSep 9, 2026\n\nSummary", "2026-09-10T10:00:00Z").toISOString().slice(0, 10)).toBe("2026-09-09");
    expect(heldAtFrom("Tue, 9 Sep 2026 · 3:00 PM", "2026-09-10T10:00:00Z").toISOString().slice(0, 10)).toBe("2026-09-09");
    expect(heldAtFrom("no date here", "2026-09-10T10:00:00Z").toISOString().slice(0, 10)).toBe("2026-09-10");
  });
});
