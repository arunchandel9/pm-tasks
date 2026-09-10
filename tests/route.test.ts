import { describe, it, expect } from "vitest";
import { route, keywordPriority, addWorkingDays } from "../src/lib/route";
import type { Client } from "../src/lib/types";

const client: Client = {
  id: "clinic-x", name: "Clinic X", scope: "client", slackChannels: [], emailDomains: [], whatsappNumbers: [], clientFacingAck: false,
  boards: {
    dev: { board: "b-dev", list: "To Do", staging: "Staging", assignee: "dev@x" },
    content: { board: "b-content", list: "To Do", staging: "Staging", assignee: "content@x" },
    scope: { board: "b-dev", list: "Needs scope" },
  },
};
const mon = new Date("2026-09-07T09:00:00Z"); // Monday

describe("priority keywords", () => {
  it("raises to P1 on keywords", () => {
    expect(keywordPriority("Our site is down since this morning").p1).toBe(true);
    expect(keywordPriority("The ad got disapproved again").p1).toBe(true);
    expect(keywordPriority("Can you tweak the FAQ copy").p1).toBe(false);
  });
});

describe("working days", () => {
  it("skips weekends", () => {
    expect(addWorkingDays(new Date("2026-09-04T09:00:00Z"), 2).toISOString().slice(0, 10)).toBe("2026-09-08"); // Fri + 2 → Tue
  });
});

describe("route", () => {
  it("routes a dev issue with SLA and assignee", () => {
    const r = route({ requestType: "dev_issue", modelDepartment: "dev", priorityHint: "P3", priorityReason: null, text: "button broken on mobile", client, now: mon });
    expect(r.board).toBe("b-dev"); expect(r.list).toBe("To Do"); expect(r.staging).toBe("Staging"); expect(r.assignee).toBe("dev@x");
    expect(r.priority).toBe("P3"); expect(r.dueAt?.toISOString().slice(0, 10)).toBe("2026-09-09"); expect(r.gated).toBe(false);
    expect(r.labels).toContain("dev");
  });
  it("P1 keyword overrides the hint and uses the hour SLA", () => {
    const r = route({ requestType: "dev_issue", modelDepartment: "dev", priorityHint: "P3", priorityReason: null, text: "booking not working at all", client, now: mon });
    expect(r.priority).toBe("P1"); expect(r.priorityReason).toContain("keyword");
    expect(r.dueAt!.getTime() - mon.getTime()).toBe(4 * 3600 * 1000);
  });
  it("new page is gated into Needs scope", () => {
    const r = route({ requestType: "new_page", modelDepartment: "seo", priorityHint: "P3", priorityReason: null, text: "we want a new landing page for botox", client, now: mon });
    expect(r.gated).toBe(true); expect(r.list).toBe("Needs scope"); expect(r.board).toBe("b-dev");
  });
  it("general update creates no card", () => {
    const r = route({ requestType: "general_update", modelDepartment: "general", priorityHint: "P3", priorityReason: null, text: "just fyi we are closed friday", client, now: mon });
    expect(r.noCard).toBe(true); expect(r.dueAt).toBeNull();
  });
  it("unknown request type falls back to the model's department", () => {
    const r = route({ requestType: "something_new", modelDepartment: "content", priorityHint: "P2", priorityReason: "deadline", text: "x", client, now: mon });
    expect(r.department).toBe("content"); expect(r.board).toBe("b-content"); expect(r.priority).toBe("P2");
  });
});

describe("hold list", () => {
  it("gated asks wait in Needs scope, everything else in Staging", async () => {
    const { holdListName } = await import("../src/lib/tasks");
    const page = route({ requestType: "new_page", modelDepartment: "seo", priorityHint: "P3", priorityReason: null, text: "new landing page", client, now: mon });
    const fix = route({ requestType: "dev_issue", modelDepartment: "dev", priorityHint: "P3", priorityReason: null, text: "button broken", client, now: mon });
    expect(holdListName(page)).toBe("Needs scope");
    expect(holdListName(fix)).toBe("Staging");
    expect(holdListName({ gated: true, list: null, staging: null })).toBe("Needs scope");
    expect(holdListName({ gated: false, list: "To Do", staging: null })).toBe("Staging");
  });
});
