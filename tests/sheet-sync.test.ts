import { describe, it, expect } from "vitest";
import { parseSheetDate, rowTitle, isUntitled } from "../src/lib/sheet-sync";

describe("which sheet rows are tasks", () => {
  it("a typed title is the title", () => {
    expect(rowTitle("Update the footer hours", "abc12345-0000")).toBe("Update the footer hours");
    expect(rowTitle("  Update the footer hours ", null)).toBe("Update the footer hours");
  });
  it("a Pulp link with a blank Task cell is still a task, under a placeholder the card check fills in", () => {
    const t = rowTitle("", "abc12345-0000-1111");
    expect(t).toBe("(untitled card abc12345)");
    expect(isUntitled(t!)).toBe(true);
    expect(isUntitled("Card design for the clinic")).toBe(false);
  });
  it("blank lines and the DONE divider are not tasks", () => {
    expect(rowTitle("", null)).toBeNull();
    expect(rowTitle("DONE", null)).toBeNull();
    expect(rowTitle("Done", "abc12345-0000")).toBeNull();
  });
});

describe("sheet dates", () => {
  it("reads the formats PMs use", () => {
    expect(parseSheetDate("08-Sep-2026")?.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(parseSheetDate("8 Sept 2026")?.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(parseSheetDate("08/09/2026")?.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(parseSheetDate("2026-09-08")?.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate("tbc")).toBeNull();
  });
});
