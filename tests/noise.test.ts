import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { slackNoise, emailNoise, isAcknowledgement, stripQuotedHistory, splitQuotedHistory } from "../src/lib/filter/noise";
import type { NoiseConfig } from "../src/lib/types";

const cfg = YAML.parse(readFileSync("config/noise.yaml", "utf8")) as NoiseConfig;
const base = { text: "", senderIsStaff: false, isIntakeChannel: false, isThreadReply: false, threadRootIsRequest: false, hasFilesOnly: false };

describe("acknowledgements", () => {
  it.each(["thanks", "Thanks!", "ok 👍", "✅", "noted.", "got it", "🙏🙏"])("skips %s", (t) => {
    expect(isAcknowledgement(t, cfg)).toBe(true);
  });
  it("keeps a real ask", () => {
    expect(isAcknowledgement("thanks, can you also update the FAQ page with the new prices?", cfg)).toBe(false);
  });
});

describe("slack rules", () => {
  it("skips staff outside #intake", () => {
    expect(slackNoise({ ...base, text: "Can you fix the contact form on the site please", senderIsStaff: true }, cfg)).toEqual({ skip: true, reason: "staff_outside_intake" });
  });
  it("keeps staff inside #intake", () => {
    expect(slackNoise({ ...base, text: "Client called: hero image on home page is stretched on mobile", senderIsStaff: true, isIntakeChannel: true }, cfg).skip).toBe(false);
  });
  it("skips bots and edits", () => {
    expect(slackNoise({ ...base, text: "long enough message here", botId: "B1" }, cfg).reason).toBe("bot_message");
    expect(slackNoise({ ...base, text: "long enough message here", subtype: "message_changed" }, cfg).reason).toBe("subtype:message_changed");
  });
  it("skips short and ack", () => {
    expect(slackNoise({ ...base, text: "ok cool" }, cfg).reason).toBe("too_short");
    expect(slackNoise({ ...base, text: "thank you so much 🙏" }, cfg).reason).toBe("acknowledgement");
  });
  it("routes attachment-only to review without a model call", () => {
    expect(slackNoise({ ...base, text: "", hasFilesOnly: true }, cfg)).toEqual({ skip: false, reason: "attachment_only" });
  });
  it("marks a short thread reply under a request as a follow-up", () => {
    expect(slackNoise({ ...base, text: "any update on this one?", isThreadReply: true, threadRootIsRequest: true }, cfg)).toEqual({ skip: false, reason: "thread_followup" });
  });
  it("lets a long thread reply run the pipeline", () => {
    const long = "Actually, change of plan: ".padEnd(220, "we want the button to open a booking form instead of a phone link, and ");
    expect(slackNoise({ ...base, text: long, isThreadReply: true, threadRootIsRequest: true }, cfg)).toEqual({ skip: false, reason: null });
  });
});

describe("email rules", () => {
  const e = { from: "priya@clinicx.co.uk", fromIsStaff: false, isForward: false, headers: {}, text: "Could you update the price list on the treatments page this week?" };
  it("keeps a client email", () => expect(emailNoise(e, cfg).skip).toBe(false));
  it("skips newsletters and auto-replies", () => {
    expect(emailNoise({ ...e, headers: { "List-Unsubscribe": "<x>" } }, cfg).reason).toBe("newsletter");
    expect(emailNoise({ ...e, headers: { "Auto-Submitted": "auto-replied" } }, cfg).reason).toBe("auto_submitted");
    expect(emailNoise({ ...e, from: "noreply@somewhere.com" }, cfg).reason).toBe("automated_sender");
  });
  it("allows ad-platform senders even if automated", () => {
    expect(emailNoise({ ...e, from: "ads-noreply@google.com", headers: { Precedence: "bulk" } }, cfg).skip).toBe(false);
  });
  it("skips our own outgoing but keeps forwards", () => {
    expect(emailNoise({ ...e, from: "arun@mangoeyesagency.com", fromIsStaff: true }, cfg).reason).toBe("staff_outgoing");
    expect(emailNoise({ ...e, from: "arun@mangoeyesagency.com", fromIsStaff: true, isForward: true }, cfg).skip).toBe(false);
  });
  it("recognises a yes to the hub's client suggestion", async () => {
    const { isAffirmative } = await import("../src/lib/filter/noise");
    for (const t of ["yes", "Yes!", "yeah that's right", "correct 👍", "ok yes", "that's it"]) expect(isAffirmative(t), t).toBe(true);
    for (const t of ["yes but for HOH", "no", "Abela", "yes the footer is broken too", ""]) expect(isAffirmative(t), t).toBe(false);
  });
  it("keeps staff mail addressed to the intake address (typed ask or shared voice note)", () => {
    expect(emailNoise({ ...e, from: "arun@mangoeyesagency.com", fromIsStaff: true, toIntake: true }, cfg).skip).toBe(false);
  });
  it("strips an Outlook-style quoted header block, as Gmail renders it (bold From line, separator, group footer)", () => {
    const t = [
      "Too little too late", "", "Sent from Outlook for Android", "", "------------------------------",
      "*From:* Renu Dahiya <renu@mangoeyesagency.com>", "*Sent:* Monday, 14 September 2026 18:18:22", "*To:* virmani.dr@gmail.com",
      "*Subject:* For Review: Treatment, Condition & Blog Page Content", "", "Hi Dr Sumit,", "Please review the content for the following pages", "",
      "--", "You received this message because you are subscribed to the Google Groups \"Client Success\" group.",
    ].join("\n");
    expect(stripQuotedHistory(t).trim()).toBe("Too little too late\n\nSent from Outlook for Android");
    const h = splitQuotedHistory(t).history;
    expect(h).toContain("Please review the content for the following pages");
    expect(h).not.toContain("You received this message");
    const plain = "Too little too late\n\nFrom: Renu Dahiya <renu@mangoeyesagency.com>\nSent: Monday\nSubject: x\n\nHi";
    expect(stripQuotedHistory(plain).trim()).toBe("Too little too late");
    // A lone "From:" inside a sentence, with no header lines after it, is not history.
    expect(stripQuotedHistory("Please update the page.\nFrom: the home page, remove the banner.").trim()).toContain("remove the banner");
  });
  it("strips quoted history", () => {
    const t = "Please swap the hero image.\n\nOn Mon, 8 Sep 2026 at 10:00, Arun <arun@mangoeyesagency.com> wrote:\n> old stuff\n> more old stuff";
    expect(stripQuotedHistory(t).trim()).toBe("Please swap the hero image.");
  });
});
