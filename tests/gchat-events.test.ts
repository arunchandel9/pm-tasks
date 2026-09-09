import { describe, it, expect } from "vitest";
import { normaliseChatEvent, replyText, replyUpdateMessage } from "../src/lib/gchat-events";

describe("google chat event normalisation", () => {
  it("add-on message", () => {
    const ev = normaliseChatEvent({ chat: { user: { email: "a@x.com" }, messagePayload: { space: { name: "spaces/A" }, message: { name: "spaces/A/messages/1", text: "@Task Hub Clinic X: fix it", argumentText: " Clinic X: fix it" } } } });
    expect(ev.format).toBe("addon"); expect(ev.kind).toBe("message"); expect(ev.space).toBe("spaces/A"); expect(ev.message?.argumentText).toContain("Clinic X");
  });
  it("add-on slash command", () => {
    const ev = normaliseChatEvent({ chat: { user: {}, appCommandPayload: { space: { name: "spaces/I" }, appCommandMetadata: { appCommandId: 1, appCommandType: "SLASH_COMMAND" } } } });
    expect(ev.kind).toBe("command"); expect(ev.commandId).toBe("1");
  });
  it("add-on button click and dialog submit", () => {
    const click = normaliseChatEvent({ chat: { user: { displayName: "Arun" }, buttonClickedPayload: { space: { name: "spaces/R" } } }, commonEventObject: { invokedFunction: "approve", parameters: { requestId: "abc" } } });
    expect(click.kind).toBe("click"); expect(click.invokedFunction).toBe("approve"); expect(click.parameters.requestId).toBe("abc");
    const submit = normaliseChatEvent({ chat: { user: {}, buttonClickedPayload: {} }, commonEventObject: { invokedFunction: "submit_task", formInputs: { request: { stringInputs: { value: ["x"] } } } } });
    expect(submit.kind).toBe("dialog_submit"); expect(submit.formInputs.request.stringInputs?.value?.[0]).toBe("x");
  });
  it("classic message, added, click", () => {
    expect(normaliseChatEvent({ type: "ADDED_TO_SPACE", space: { name: "spaces/A" } }).kind).toBe("added");
    expect(normaliseChatEvent({ type: "MESSAGE", space: { name: "spaces/A" }, message: { name: "m", text: "hi" } }).kind).toBe("message");
    const c = normaliseChatEvent({ type: "CARD_CLICKED", action: { actionMethodName: "dismiss", parameters: [{ key: "requestId", value: "r1" }] } });
    expect(c.kind).toBe("click"); expect(c.invokedFunction).toBe("dismiss"); expect(c.parameters.requestId).toBe("r1");
  });
  it("replies per format", () => {
    expect(replyText("classic", "hi")).toEqual({ text: "hi" });
    expect((replyText("addon", "hi") as { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: string } } } } }).hostAppDataAction.chatDataAction.createMessageAction.message.text).toBe("hi");
    expect((replyUpdateMessage("classic", "x") as { actionResponse: { type: string } }).actionResponse.type).toBe("UPDATE_MESSAGE");
  });
});

describe("add-on button functions are URLs", () => {
  it("recovers the handler name from the URL form and from the request hint", () => {
    const ev = { chat: { buttonClickedPayload: { space: { name: "spaces/x" } }, user: { email: "a@b" } }, commonEventObject: { invokedFunction: "https://pm-tasks.vercel.app/api/gchat?fn=submit_task", formInputs: { request: { stringInputs: { value: ["hi"] } } } } };
    expect(normaliseChatEvent(ev).kind).toBe("dialog_submit");
    expect(normaliseChatEvent({ chat: { buttonClickedPayload: {} }, commonEventObject: {} }, "approve").invokedFunction).toBe("approve");
  });
});
