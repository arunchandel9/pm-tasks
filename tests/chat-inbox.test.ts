import { describe, it, expect } from "vitest";
import { newHumanMessages, toChatMessage } from "../src/lib/chat-inbox";

const msg = (name: string, createTime: string, extra: Record<string, unknown> = {}) => ({ name, createTime, text: "hi", sender: { name: "users/1", type: "HUMAN" }, ...extra });

describe("Task Hub Drop space poll", () => {
  it("keeps only messages newer than the last one handled, oldest first, never the hub's own", () => {
    const list = [
      msg("spaces/s/messages/c", "2026-09-14T10:00:03Z"),
      msg("spaces/s/messages/b", "2026-09-14T10:00:02Z", { sender: { name: "users/app", type: "BOT" } }),
      msg("spaces/s/messages/a", "2026-09-14T10:00:01Z"),
      msg("spaces/s/messages/old", "2026-09-14T09:59:59Z"),
    ];
    expect(newHumanMessages(list, "2026-09-14T10:00:00Z").map((m) => m.name)).toEqual(["spaces/s/messages/a", "spaces/s/messages/c"]);
  });
  it("converts an API message to the DM handler's shape, with the sender's name from the members map", () => {
    const m = toChatMessage(
      { name: "spaces/s/messages/a", createTime: "2026-09-14T10:00:01Z", text: "@Task Hub HOH: fix the footer", argumentText: "HOH: fix the footer", sender: { name: "users/1", type: "HUMAN" }, thread: { name: "spaces/s/threads/t" },
        attachment: [{ name: "spaces/s/messages/a/attachments/x", contentName: "PTT-1.opus", contentType: "audio/ogg", attachmentDataRef: { resourceName: "r1" } }] },
      new Map([["users/1", "Priya"]]),
    );
    expect(m.sender?.displayName).toBe("Priya");
    expect(m.argumentText).toBe("HOH: fix the footer");
    expect(m.thread?.name).toBe("spaces/s/threads/t");
    expect(m.attachment?.[0].attachmentDataRef?.resourceName).toBe("r1");
  });
});
