import { describe, it, expect } from "vitest";
import { draftLine, followupLine, feedHeadline, newTasksHeadline, followupHeadline, reviewMode, splitDetail } from "../src/lib/review";
import type { Client, Message } from "../src/lib/types";

const client = { id: "hoh", name: "HOH", scope: "client" } as Client;
const message = { channel: "slack", sender: "Dr Mehta", text: "the Book Now button on the contact page isn't working on mobile", permalink: null } as unknown as Message;

describe("feed headlines say what the thread is about, nothing more", () => {
  it("defaults to notify mode", () => { expect(reviewMode()).toBe("notify"); });
  it("one task: client, what, department, source; no title, no link", () => {
    expect(newTasksHeadline({ client, message, cards: [{ priority: "P2", department: "dev" }] })).toBe("🆕 *HOH* · new task · Dev · Slack, Dr Mehta");
    expect(newTasksHeadline({ client, message, cards: [{ priority: "P1", department: "dev" }] })).toBe("🔴 *HOH* · P1 task · Dev · Slack, Dr Mehta");
  });
  it("several tasks: a count; the department only when they share one", () => {
    expect(newTasksHeadline({ client, message, cards: [{ priority: "P2", department: "dev" }, { priority: "P3", department: "seo" }] })).toBe("🆕 *HOH* · 2 new tasks · Slack, Dr Mehta");
    expect(newTasksHeadline({ client, message, cards: [{ priority: "P1", department: "dev" }, { priority: "P3", department: "dev" }] })).toBe("🔴 *HOH* · 2 new tasks, one P1 · Dev · Slack, Dr Mehta");
  });
  it("follow-ups, unhappy clients and internal asks", () => {
    expect(followupHeadline({ client, message, kind: "followup_change" })).toBe("🔁 *HOH* · update to a task · Slack, Dr Mehta");
    expect(followupHeadline({ client, message, kind: "possible_duplicate" })).toBe("🔁 *HOH* · same as an open task · Slack, Dr Mehta");
    expect(feedHeadline({ icon: "⚠️", client, what: "client unhappy, reply needed", message })).toBe("⚠️ *HOH* · client unhappy, reply needed · Slack, Dr Mehta");
    expect(feedHeadline({ icon: "ℹ️", client: { id: "me", name: "MangoEyes", scope: "internal" } as Client, what: "noted, no task", message: { ...message, channel: "intake", sender: "Arun" } as Message })).toBe("ℹ️ *MangoEyes* (internal) · noted, no task · Task Hub, Arun");
  });
});

describe("the card lines inside the thread", () => {
  it("one line per task with title, department, priority and the Staging card link; no source (the headline has it)", () => {
    const line = draftLine({ client, title: "Fix Book Now button on mobile", department: "dev", priority: "P2", gated: false, pulpLink: "https://pulp.mangoeyes.io/board/0fac54b7/card/abc" });
    expect(line).toBe("🆕 *HOH* · Fix Book Now button on mobile · Dev · P2 · <https://pulp.mangoeyes.io/board/0fac54b7/card/abc|Staging card>");
  });
  it("P1 is marked at the start and needs-scope is flagged", () => {
    const line = draftLine({ client, title: "Site is down", department: "dev", priority: "P1", gated: true, pulpLink: "x" });
    expect(line.startsWith("🔴 *P1* *HOH*")).toBe(true);
    expect(line).toContain("<x|Needs scope card>");
    expect(line).not.toContain("Staging");
  });
  it("gated ask without a card yet still says needs scope", () => {
    const line = draftLine({ client, title: "New botox landing page", department: "seo", priority: "P3", gated: true, pulpLink: null });
    expect(line).toContain("needs scope, card pending");
  });
  it("follow-ups say which task they were noted on", () => {
    const line = followupLine({ client, existingTitle: "Fix Book Now button on mobile", kind: "followup_change" });
    expect(line).toBe("🔁 *HOH* · update to *Fix Book Now button on mobile* · noted on its card");
    const linked = followupLine({ client, existingTitle: "Fix Book Now button on mobile", kind: "possible_duplicate", pulpLink: "https://pulp/x" });
    expect(linked).toContain("same as");
    expect(linked).toContain("<https://pulp/x|card>");
  });
});

describe("detail cards", () => {
  it("turns Chat markup into card HTML", async () => {
    const { toCardHtml } = await import("../src/lib/review");
    expect(toCardHtml('"Too little too late"\n*Context:* reacts to the review request · <https://pulp/x|card> · <https://mail/y>'))
      .toBe('&quot;Too little too late&quot;<br><b>Context:</b> reacts to the review request · <a href="https://pulp/x">card</a> · <a href="https://mail/y">https://mail/y</a>'.replace(/&quot;/g, '"'));
    expect(toCardHtml("a < b & c")).toBe("a &lt; b &amp; c");
  });
});

describe("acknowledgement wording", () => {
  it("turns reason codes into plain English", async () => {
    const { humanOutcome } = await import("../src/lib/review");
    expect(humanOutcome("skipped", "no_ask")).toMatch(/nothing was asked/);
    expect(humanOutcome("attached", "nudge")).toMatch(/chase/);
    expect(humanOutcome("skipped", "weird_code")).toBe("nothing to do (weird code).");
  });
});

describe("a long note is split into several boxes", () => {
  it("keeps short notes whole and splits long ones at paragraph or line breaks", () => {
    expect(splitDetail("short")).toEqual(["short"]);
    const lines = Array.from({ length: 120 }, (_, i) => `• Client ${i} · a task title of ordinary length · card`).join("\n");
    const parts = splitDetail(`*New today (120)*\n${lines}`, 3500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3500);
    expect(parts.join("\n")).toContain("• Client 119");
  });
});
