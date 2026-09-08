import { describe, it, expect } from "vitest";
import { mapHeaders, colLetter } from "../src/lib/sheets";

describe("header mapping", () => {
  it("maps a typical pre-built client tab", () => {
    const headers = ["S No", "Date", "Task Description", "Department", "Priority", "Assigned To", "Status", "Due Date", "Notes", "Link"];
    const m = mapHeaders(headers);
    expect(headers[m.task_id]).toBe("S No");
    expect(headers[m.created]).toBe("Date");
    expect(headers[m.title]).toBe("Task Description");
    expect(headers[m.department]).toBe("Department");
    expect(headers[m.stage]).toBe("Status");
    expect(headers[m.due]).toBe("Due Date");
    expect(headers[m.assignee]).toBe("Assigned To");
    expect(headers[m.source_link]).toBe("Link");
    expect(m.completed).toBeUndefined();
  });
  it("ignores punctuation and case", () => {
    const m = mapHeaders(["TASK  ID:", "task-name", "STATUS"]);
    expect(m.task_id).toBe(0); expect(m.title).toBe(1); expect(m.stage).toBe(2);
  });
  it("column letters", () => {
    expect(colLetter(0)).toBe("A"); expect(colLetter(25)).toBe("Z"); expect(colLetter(26)).toBe("AA"); expect(colLetter(27)).toBe("AB");
  });
});
