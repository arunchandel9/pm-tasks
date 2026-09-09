import { describe, it, expect } from "vitest";
import { normList, isDoneList } from "../src/lib/pulp";

describe("Pulp list names", () => {
  it("matches To Do across the boards' spellings", () => {
    for (const n of ["To Do", "To-Do", "To-do", "TODO", " to do "]) expect(normList(n)).toBe("todo");
    expect(normList("Needs scope")).toBe(normList("needs-scope"));
  });
  it("only real Done lists count as finished", () => {
    for (const n of ["Done", "Done (Final Delivery)", "Completed", "Closed"]) expect(isDoneList(n)).toBe(true);
    for (const n of ["Ready to Use / Go Live", "QA Testing Done", "Doing", "Client Updates / Review", "Anuj/Renu QA Review"]) expect(isDoneList(n)).toBe(false);
  });
});
