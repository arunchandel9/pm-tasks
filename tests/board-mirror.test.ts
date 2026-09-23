import { describe, it, expect } from "vitest";
import { planMirror, clientFromCard, priorityFromLabels, ARCHIVED_NOTE, type KnownCard } from "../src/lib/board-mirror";
import type { BoardCard } from "../src/lib/pulp";
import type { Client } from "../src/lib/types";

const client = (id: string, name: string, aliases: string[] = []): Client => ({ id, name, scope: "client", slackChannels: [], emailDomains: [], whatsappNumbers: [], boards: {}, clientFacingAck: false, aliases });
const clients = [client("hoh", "House Of Health", ["HOH"]), client("tsf", "The SKIN Firm", ["TSF", "Skin Firm"])];
const card = (id: string, listId: string, title = "x", labels: string[] = []): BoardCard => ({ id, boardId: "b", listId, title, labels, members: [], dueAt: null, createdAt: null });
const known = (pulp: string, origin: string, list: string | null, extra: Partial<KnownCard> = {}): KnownCard => ({ id: `t-${pulp}`, pulp_card_id: pulp, list_id: list, origin, title: "x", completed_at: null, notes: null, labels: [], ...extra });

describe("the board mirror", () => {
  it("adds cards nobody tracks, leaves hub and sheet cards to their own polls, follows moves, archives what left", () => {
    const plan = planMirror(
      [known("hub1", "hub", "l1"), known("sheet1", "sheet", "l1"), known("b1", "board", "l1"), known("b2", "board", "l1"), known("gone", "board", "l1")],
      [card("hub1", "l2"), card("sheet1", "l2"), card("b1", "l2"), card("b2", "l1"), card("new1", "l1")],
    );
    expect(plan.insert.map((c) => c.id)).toEqual(["new1"]);
    expect(plan.update.map((u) => [u.id, u.moved, u.fromList])).toEqual([["t-b1", true, "l1"]]);
    expect(plan.archive).toEqual(["t-gone"]);
  });
  it("updates a card whose title or labels changed, and brings an archived card back when it reappears", () => {
    const plan = planMirror([known("b1", "board", "l1", { title: "old" }), known("b2", "board", "l1", { labels: ["P2"] }), known("b3", "board", "l1", { notes: ARCHIVED_NOTE })], [card("b1", "l1", "new"), card("b2", "l1", "x", ["P1"]), card("b3", "l1")]);
    expect(plan.update.map((u) => [u.id, u.moved])).toEqual([["t-b1", false], ["t-b2", false], ["t-b3", false]]);
  });
  it("archives nothing when the board read hit Pulp's cap", () => {
    expect(planMirror([known("gone", "board", "l1")], [card("a", "l1")], true).archive).toEqual([]);
    expect(planMirror([known("gone", "board", "l1", { notes: ARCHIVED_NOTE })], [card("a", "l1")]).archive).toEqual([]);
  });
  it("finds the client from a label first, then the title, else none", () => {
    expect(clientFromCard({ title: "HBOT week 3 video", labels: ["hoh", "P1"] }, clients)).toBe("hoh");
    expect(clientFromCard({ title: "HOH - HBOT week 3 video", labels: [] }, clients)).toBe("hoh");
    expect(clientFromCard({ title: "Skin Firm pricing page", labels: [] }, clients)).toBe("tsf");
    expect(clientFromCard({ title: "HBOT week 3 video", labels: ["Task Hub"] }, clients)).toBeNull();
  });
  it("reads the priority from the labels", () => {
    expect(priorityFromLabels(["Task Hub", "p1"])).toBe("P1");
    expect(priorityFromLabels(["Week 30", "P1 Task", "HOH"])).toBe("P1");
    expect(priorityFromLabels(["P10"])).toBe("P3");
    expect(priorityFromLabels(["P2"])).toBe("P2");
    expect(priorityFromLabels([])).toBe("P3");
  });
});
