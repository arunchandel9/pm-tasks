import { describe, it, expect } from "vitest";
import { renderBrief, type BriefData } from "../src/lib/brief";

const empty: BriefData = { day: "Mon 14 Sep", newToday: [], stale: [], questions: [], waitingOnClient: [], issues: [], overdue: [], done: [] };

describe("daily brief", () => {
  it("is one quiet line when there is nothing to act on", () => {
    const b = renderBrief(empty);
    expect(b.headline).toBe("📋 *Daily brief · Mon 14 Sep* · quiet day");
    expect(b.detail).toBeNull();
  });
  it("the headline is the label; counts open the thread, then only non-empty sections, links on cards", () => {
    const b = renderBrief({
      ...empty,
      newToday: [{ client: "Abela", title: "Add WhatsApp button", link: "https://pulp/x", priority: "P2", hold: true }],
      stale: [{ client: "HOH", title: "Publish price list", days: 5, link: null }],
      questions: [{ text: "please fix the popup", source: "Task Hub, Arun", why: "which client?" }],
      overdue: [{ client: "TED", title: "Pricing page edits", priority: "P1", due: "Fri 11 Sep", link: "https://pulp/y" }],
      done: [{ client: "HOH", title: "Fix Book Now button" }],
    });
    expect(b.headline).toBe("📋 *Daily brief · Mon 14 Sep*");
    expect(b.detail?.startsWith("1 new · 2 waiting on you · 1 overdue · 1 done\n")).toBe(true);
    expect(b.detail).toContain("*New today (1)*");
    expect(b.detail).toContain("<https://pulp/x|card>");
    expect(b.detail).toContain("in Staging for more than a day");
    expect(b.detail).toContain('which client? "please fix the popup"');
    expect(b.detail).toContain("🔴 TED · Pricing page edits · due Fri 11 Sep");
    expect(b.detail).not.toContain("Issues");
    expect(b.detail).not.toContain("Moved");
  });
});
