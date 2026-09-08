import { describe, it, expect } from "vitest";
import { draftLine, followupLine, reviewMode } from "../src/lib/review";
import type { Client, Message } from "../src/lib/types";

const client = { id: "hoh", name: "HOH", scope: "client" } as Client;
const message = { channel: "slack", sender: "Dr Mehta", text: "the Book Now button on the contact page isn't working on mobile", permalink: null } as unknown as Message;

describe("PM Review feed lines", () => {
  it("defaults to notify mode", () => { expect(reviewMode()).toBe("notify"); });
  it("one short line per task, link to the Staging card", () => {
    const line = draftLine({ client, title: "Fix Book Now button on mobile", department: "dev", priority: "P2", gated: false, pulpLink: "https://pulp.mangoeyes.io/board/0fac54b7/card/abc", message });
    expect(line).toBe("🆕 *HOH* · Fix Book Now button on mobile · Dev · P2 · <https://pulp.mangoeyes.io/board/0fac54b7/card/abc|Staging card> · Slack, Dr Mehta");
  });
  it("P1 is marked at the start and needs-scope is flagged", () => {
    const line = draftLine({ client, title: "Site is down", department: "dev", priority: "P1", gated: true, pulpLink: "x", message });
    expect(line.startsWith("🔴 *P1* *HOH*")).toBe(true);
    expect(line).toContain("needs scope");
  });
  it("follow-ups say which task they were noted on", () => {
    const line = followupLine({ client, existingTitle: "Fix Book Now button on mobile", kind: "followup_change", message });
    expect(line).toBe("🔁 *HOH* · \"the Book Now button on the contact page isn't working on mobile\" · update to *Fix Book Now button on mobile* · noted on its card");
  });
});
