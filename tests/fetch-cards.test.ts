import { describe, it, expect, vi } from "vitest";

const calls: string[] = [];
let inFlight = 0, peak = 0;
vi.mock("../src/lib/pulp", () => ({
  pulp: {
    async getCard(id: string) {
      calls.push(id); inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (id === "gone") throw new Error("GET /cards/gone → 404");
      return { id, boardId: "b", listId: "l", title: id };
    },
  },
  isDoneList: () => false,
  normList: (s: string) => s.toLowerCase(),
}));

import { fetchCards, FETCH_BATCH } from "../src/lib/sheet-cards";

describe("cards are fetched ten at a time, not one after another", () => {
  it("runs a batch in parallel, keeps the order, reports a missing card without stopping", async () => {
    const rows = Array.from({ length: 23 }, (_, i) => ({ pulp_card_id: i === 4 ? "gone" : `c${i}` }));
    const out = [];
    for await (const r of fetchCards(rows)) out.push(r);
    expect(out.length).toBe(23);
    expect(out.map((r) => r.row.pulp_card_id)).toEqual(rows.map((r) => r.pulp_card_id));
    expect(out[4].card).toBeNull();
    expect(out[4].error).toMatch(/404/);
    expect(out[5].card?.id).toBe("c5");
    expect(peak).toBe(FETCH_BATCH);
  });
  it("stops between batches when the minute is running out", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ pulp_card_id: `d${i}` }));
    let batches = 0;
    const out = [];
    for await (const r of fetchCards(rows, () => batches++ >= 1)) out.push(r);
    expect(out.length).toBe(FETCH_BATCH + 1);
    expect(out.at(-1)?.error).toBe("timeout");
  });
});
