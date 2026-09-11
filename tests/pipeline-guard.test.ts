import { describe, it, expect } from "vitest";
import { PROBLEM } from "../src/lib/pipeline";

describe("problem statements are asks", () => {
  it("matches the usual bug wording", () => {
    for (const t of ["the Book Now CTA is not working", "form is broken", "site down since morning", "leads stopped coming", "Is not working."]) expect(PROBLEM.test(t)).toBe(true);
    for (const t of ["thanks a lot", "we are closed on friday", "great work team"]) expect(PROBLEM.test(t)).toBe(false);
  });
});
