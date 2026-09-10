import { describe, it, expect } from "vitest";
import { sheetCardAction } from "../src/lib/sheet-cards";

describe("hand-made cards linked in the sheet", () => {
  it("first look only records where the card is", () => {
    expect(sheetCardAction({ lastListId: null, cardListId: "l-todo", done: false, sheetStatus: "Waiting on client", wanted: "To-Do" })).toBe("baseline");
  });
  it("first look closes the row when the card is already Done", () => {
    expect(sheetCardAction({ lastListId: null, cardListId: "l-done", done: true, sheetStatus: "In Progress", wanted: "Done" })).toBe("write");
    expect(sheetCardAction({ lastListId: null, cardListId: "l-done", done: true, sheetStatus: "done", wanted: "Done" })).toBe("baseline");
  });
  it("unchanged list: nothing to do", () => {
    expect(sheetCardAction({ lastListId: "l-todo", cardListId: "l-todo", done: false, sheetStatus: "anything", wanted: "To-Do" })).toBe("skip");
  });
  it("moved list: write the new status unless the sheet already says so", () => {
    expect(sheetCardAction({ lastListId: "l-todo", cardListId: "l-prog", done: false, sheetStatus: "To-Do", wanted: "In Progress" })).toBe("write");
    expect(sheetCardAction({ lastListId: "l-todo", cardListId: "l-prog", done: false, sheetStatus: "in progress", wanted: "In Progress" })).toBe("baseline");
    expect(sheetCardAction({ lastListId: "l-prog", cardListId: "l-done", done: true, sheetStatus: "In Progress", wanted: "Done" })).toBe("write");
  });
});
