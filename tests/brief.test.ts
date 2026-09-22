import { describe, it, expect } from "vitest";
import { renderBrief, waitingSummary, type BriefData } from "../src/lib/brief";

const empty: BriefData = { day: "Tue 22 Sep", waiting: [], overdue: [], yesterday: { created: 3, done: 2, noCard: 1, reminders: 0 }, issues: [] };

describe("the daily brief lists only what a named person must do today", () => {
  it("posts nothing at all when nobody has anything to do", () => {
    expect(renderBrief(empty)).toBeNull();
  });
  it("names the people in the headline and @mentions them in the thread", () => {
    const b = renderBrief({
      ...empty,
      waiting: [
        { who: "Heena Ganotra", whoUser: "users/1", client: "The SKIN Firm", what: 'task to confirm: "Update pricing"', since: "2 h ago" },
        { who: "Heena Ganotra", whoUser: "users/1", client: "The Eye Doctor", what: "reminder: chase the GP", since: "due Tue 22 Sept" },
        { who: "PMs", whoUser: null, client: "House Of Health", what: 'Nadir is waiting for a reply in Slack: "prices"', since: "1 d without a reply" },
      ],
      overdue: [{ client: "House Of Health", title: "Urgent eye care landing page", priority: "P1", due: "Fri 18 Sept", assignee: "Anuj", link: "https://pulp/x" }],
    })!;
    expect(b.headline).toBe("📋 Today · Tue 22 Sep · 2 things waiting on Heena Ganotra, 1 on the PMs · 1 overdue");
    expect(b.detail).toContain("*Waiting on you*");
    expect(b.detail).toContain('• <users/1>: *The SKIN Firm* · task to confirm: "Update pricing" · 2 h ago');
    expect(b.detail).toContain("• PMs: *House Of Health* · Nadir is waiting");
    expect(b.detail).toContain("*Overdue*");
    expect(b.detail).toContain("• 🔴 Anuj: *House Of Health* · Urgent eye care landing page · was due Fri 18 Sept · <https://pulp/x|card>");
    expect(b.detail).toContain("*Yesterday* · 3 cards created · 2 done · 1 no card · 0 reminders set");
    expect(b.detail).not.toContain("and 3 more");
  });
  it("issues for Arun keep the brief alive even when the team has nothing waiting", () => {
    const b = renderBrief({ ...empty, issues: ["Mailbox last ran 40 min ago"] })!;
    expect(b.headline).toContain("1 issue for Arun");
    expect(b.detail).toContain("*Issues (Arun)*");
  });
  it("summarises who is waiting for how many", () => {
    expect(waitingSummary([{ who: "A", whoUser: null, client: "", what: "", since: "" }])).toBe("1 thing waiting on A");
  });
});
