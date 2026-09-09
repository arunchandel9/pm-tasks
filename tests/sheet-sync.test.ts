import { describe, it, expect } from "vitest";
import { parseSheetDate } from "../src/lib/sheet-sync";

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
