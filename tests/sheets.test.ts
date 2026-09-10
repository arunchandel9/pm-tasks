import { describe, it, expect } from "vitest";
import { mapHeaders, colLetter, placement, formatDate, departmentLabel, formatStamp, approverLabel, renderNote, sheetConfig } from "../src/lib/sheets";

const H = ["S. NO.", "TASK", "CARD LINK", "DATE ADDED", "DUE DATE", "PRIORITY", "ASSIGNED TO", "STATUS", "DEPARTMENT", "COMMENTS"];

describe("PM Overview header mapping", () => {
  it("maps the standard client tab", () => {
    const m = mapHeaders(H);
    expect(H[m.serial]).toBe("S. NO."); expect(H[m.title]).toBe("TASK"); expect(H[m.pulp_link]).toBe("CARD LINK");
    expect(H[m.created]).toBe("DATE ADDED"); expect(H[m.due]).toBe("DUE DATE"); expect(H[m.priority]).toBe("PRIORITY");
    expect(H[m.assignee]).toBe("ASSIGNED TO"); expect(H[m.stage]).toBe("STATUS"); expect(H[m.department]).toBe("DEPARTMENT"); expect(H[m.notes]).toBe("COMMENTS");
  });
  it("prefers PULP LINK over TRELLO LINK when both exist", () => {
    const h = ["S. NO.", "TASK", "PULP LINK", "TRELLO LINK", "DATE ADDED", "DUE DATE", "PRIORITY", "ASSIGNED TO", "STATUS", "DEPARTMENT", "COMMENTS"];
    const m = mapHeaders(h);
    expect(h[m.pulp_link]).toBe("PULP LINK"); expect(h[m.trello_link]).toBe("TRELLO LINK");
  });
  it("treats a blank header right after TASK as the pulp link", () => {
    const h = ["S. NO.", "TASK", "", "TRELLO LINK", "DATE ADDED", "DUE DATE", "PRIORITY", "ASSIGNED TO", "STATUS", "DEPARTMENT", "COMMENTS"];
    expect(mapHeaders(h).pulp_link).toBe(2);
  });
  it("column letters", () => { expect(colLetter(0)).toBe("A"); expect(colLetter(25)).toBe("Z"); expect(colLetter(26)).toBe("AA"); });
  it("dates and department labels", () => {
    expect(formatDate(new Date(2026, 8, 8))).toBe("08-Sep-2026");
    expect(departmentLabel("dev")).toBe("Development"); expect(departmentLabel("design")).toBe("Graphics"); expect(departmentLabel("seo")).toBe("SEO");
  });
});

describe("comments stamp", () => {
  const t = sheetConfig().initial_note;
  it("stamps who, when and where", () => {
    expect(formatStamp(new Date(Date.UTC(2026, 8, 8, 9, 2)), "Asia/Kolkata")).toBe("08-Sep-2026 14:32 IST");
    expect(renderNote(t, { who: "Priya", when: "08-Sep-2026 14:32 IST", source: "Slack, Dr Mehta" }))
      .toBe("Task assigned. Added by Task Hub · approved by Priya · 08-Sep-2026 14:32 IST · from Slack, Dr Mehta");
  });
  it("names the approver sensibly", () => {
    expect(approverLabel("Priya Sharma")).toBe("Priya Sharma");
    expect(approverLabel("pulp:drag")).toBe("drag in Pulp");
    expect(approverLabel("system:retry")).toBe("Task Hub");
    expect(approverLabel(null)).toBe("Task Hub");
  });
  it("drops dangling labels when a value is missing", () => {
    expect(renderNote(t, { who: "Priya", when: "08-Sep-2026 14:32 IST", source: "" }))
      .toBe("Task assigned. Added by Task Hub · approved by Priya · 08-Sep-2026 14:32 IST");
  });
});

describe("row placement", () => {
  const m = mapHeaders(H);
  it("inserts above the DONE divider and continues the serial", () => {
    const rows = [H, ["1", "Task A", "", "", "", "P1", "X", "To Do", "SEO", ""], ["2", "Task B", "", "", "", "P2", "Y", "In Progress", "Content", ""], ["DONE"], ["1", "Old", "", "", "", "P1", "X", "Done", "SEO", ""]];
    expect(placement(rows, m)).toEqual({ insertAt: 3, nextSerial: 3 });
  });
  it("appends after the last filled row when there is no divider, ignoring pre-numbered empty rows", () => {
    const rows = [H, ["1", "Task A", "", "", "", "P1", "X", "To Do", "SEO", ""], ["2"], ["3"], ["4"]];
    expect(placement(rows, m)).toEqual({ insertAt: 2, nextSerial: 2 });
  });
  it("first row of an empty tab", () => {
    expect(placement([H], m)).toEqual({ insertAt: 1, nextSerial: 1 });
  });
});

describe("new-row colour", () => {
  it("reads a hex colour and ignores junk", async () => {
    const { rowColour } = await import("../src/lib/sheets");
    expect(rowColour("#FFF2CC")).toEqual({ red: 1, green: 242 / 255, blue: 204 / 255 });
    expect(rowColour("fff2cc")).not.toBeNull();
    expect(rowColour("")).toBeNull();
    expect(rowColour("yellow")).toBeNull();
  });
});
