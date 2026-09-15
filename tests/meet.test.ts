import { describe, it, expect } from "vitest";
import { meetingTitle, heldAtFrom, notesNotReady } from "../src/lib/meet";

describe("a notes doc Gemini has not finished", () => {
  const real = "Sep 15, 2026\n\nSummary\n" + "The client asked for the booking page to be fixed and a new offer banner. ".repeat(12) + "\nAction items\n- Fix the booking page (Vishnu)";
  it("is not ready when short or when it says the notes are still being generated", () => {
    expect(notesNotReady("")).toBe(true);
    expect(notesNotReady("Sep 15, 2026\nNotes are being generated and will appear here shortly.")).toBe(true);
    expect(notesNotReady("x".repeat(500) + " Transcription is in progress.")).toBe(true);
  });
  it("is ready once real notes are there", () => {
    expect(notesNotReady(real)).toBe(false);
  });
  it("is not ready when the sorter found nothing and blames the transcript", () => {
    expect(notesNotReady(real, ["No usable meeting content was captured due to a transcription issue."], 0)).toBe(true);
    expect(notesNotReady(real, ["Booking page fix agreed."], 0)).toBe(false);
  });
});

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
