import { describe, it, expect } from "vitest";
import { moveOutcome, pickDepartment } from "../src/lib/tasks";
import { cardIdInLink } from "../src/lib/sheets";

const PMS = "11111111-aaaa-4bbb-8ccc-000000000001";
const DEV = "0fac54b7-3a47-4645-9d67-87f7d24ed32a";
const entries: Array<[string, string | null]> = [["seo", "d4424c02-a0ee-4bec-93be-afb4d6547a88"], ["dev", DEV], ["general", PMS], ["internal", PMS], ["scope", DEV]];

describe("PMs board: which department a board is", () => {
  it("a department board reads as its department, the PMs board as general", () => {
    expect(pickDepartment(DEV, entries)).toBe("dev");
    expect(pickDepartment(PMS.toUpperCase(), entries)).toBe("general");
  });
  it("an unknown board keeps the department it had", () => {
    expect(pickDepartment("99999999-0000-4000-8000-000000000000", entries)).toBeNull();
  });
});

describe("PMs board: what a card move means for the sheet", () => {
  it("Staging → To Do on a department board: approve and write the row", () => {
    expect(moveOutcome({ wasStaging: true, hasRow: false, manualBoard: false })).toEqual({ approve: true, writeRow: true });
  });
  it("Staging → To Do within the PMs board: approve, no row (the PM adds it by hand)", () => {
    expect(moveOutcome({ wasStaging: true, hasRow: false, manualBoard: true })).toEqual({ approve: true, writeRow: false });
  });
  it("PMs board → a department board later: the row is written then", () => {
    expect(moveOutcome({ wasStaging: false, hasRow: false, manualBoard: false })).toEqual({ approve: false, writeRow: true });
  });
  it("Development Staging → Writers To Do: approve and write, like any drag out of Staging", () => {
    expect(moveOutcome({ wasStaging: true, hasRow: false, manualBoard: false })).toEqual({ approve: true, writeRow: true });
  });
  it("a card that already has a row: nothing new, whatever board it moves to", () => {
    expect(moveOutcome({ wasStaging: false, hasRow: true, manualBoard: false })).toEqual({ approve: false, writeRow: false });
    expect(moveOutcome({ wasStaging: false, hasRow: true, manualBoard: true })).toEqual({ approve: false, writeRow: false });
  });
});

describe("rows are found by card id, not by the board in the link", () => {
  it("reads the card id from both link shapes", () => {
    expect(cardIdInLink("https://pulp.mangoeyes.io/board/0fac54b7-3a47?card=ABCDEF12-3456-7890-abcd-ef1234567890")).toBe("abcdef12-3456-7890-abcd-ef1234567890");
    expect(cardIdInLink("https://pulp.mangoeyes.io/card/abcdef12-3456")).toBe("abcdef12-3456");
    expect(cardIdInLink("https://pulp.mangoeyes.io/board/0fac54b7")).toBeNull();
  });
});
