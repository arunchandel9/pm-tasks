import { describe, it, expect } from "vitest";
import { windowBounds, windowLabel } from "../src/lib/hub";

describe("look-back windows on the reading tools", () => {
  it("a single day is that calendar day in Indian time", () => {
    const b = windowBounds({ from: "2025-03-12" }, 7);
    expect(b.since).toBe("2025-03-11T18:30:00.000Z"); // 00:00 IST on the 12th
    expect(b.until).toBe("2025-03-12T18:30:00.000Z"); // 00:00 IST on the 13th
    expect(windowBounds({ to: "2025-03-12" }, 7)).toEqual(b);
  });
  it("from and to are both inclusive", () => {
    const b = windowBounds({ from: "2025-03-01", to: "2025-03-15" }, 7);
    expect(b.since).toBe("2025-02-28T18:30:00.000Z");
    expect(b.until).toBe("2025-03-15T18:30:00.000Z");
  });
  it("dates win over days; days alone is a rolling window; nothing means the default", () => {
    expect(windowBounds({ from: "2025-03-12", days: 3 }, 7).until).not.toBeNull();
    const rolling = windowBounds({ days: 3 }, 7);
    expect(rolling.until).toBeNull();
    expect(Date.now() - new Date(rolling.since!).getTime()).toBeGreaterThan(3 * 86_400_000 - 5_000);
    expect(windowBounds({}, null)).toEqual({ since: null, until: null });
    expect(windowBounds({}, 30).since).not.toBeNull();
  });
  it("rejects a date that is not YYYY-MM-DD", () => {
    expect(() => windowBounds({ from: "12/03/2025" }, 7)).toThrow(/YYYY-MM-DD/);
  });
  it("labels read naturally", () => {
    expect(windowLabel({ from: "2025-03-12" }, 1)).toBe("12 Mar 2025");
    expect(windowLabel({ from: "2025-03-01", to: "2025-03-15" }, 1)).toBe("1 Mar 2025 to 15 Mar 2025");
    expect(windowLabel({ days: 7 }, 1)).toBe("last 7 days");
    expect(windowLabel({}, 1)).toBe("today");
  });
});
