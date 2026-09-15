import { describe, it, expect } from "vitest";
import { cleanSlackText, mentionedUsers, clientForWorkspaceName, isAudioFile, slackToMessage } from "../src/lib/normalize/slack";
import { reminderHeadline, markLabel, ACK_WORDS, nextMark } from "../src/lib/slack-replies";
import type { Client } from "../src/lib/types";

const client = (id: string, name: string, aliases: string[] = []): Client => ({ id, name, scope: "client", slackChannels: [], emailDomains: [], whatsappNumbers: [], boards: {}, clientFacingAck: false, aliases });
const clients = [client("abela", "Abela"), client("ted", "The Eye Doctor", ["TED", "Eye Doctor"]), client("hoh", "House Of Health", ["HOH"])];

describe("Slack text as a person wrote it", () => {
  it("turns mentions, links and entities into words", () => {
    expect(cleanSlackText("<@U1> can you fix <https://abela.co/book|the booking page>? it&amp;s broken <https://x.y>", { U1: "Renu" }))
      .toBe("@Renu can you fix the booking page (https://abela.co/book)? it&s broken https://x.y");
    expect(cleanSlackText("<!here> see <#C1|general> and <@U9|dr.mehta>")).toBe("@here see #general and @dr.mehta");
  });
  it("lists the people tagged", () => {
    expect(mentionedUsers("<@U1> and <@U2|x> and <@U1> again")).toEqual(["U1", "U2"]);
    expect(mentionedUsers("nobody here")).toEqual([]);
  });
  it("knows a voice clip by type, filetype or name", () => {
    expect(isAudioFile({ mimetype: "audio/mp4" })).toBe(true);
    expect(isAudioFile({ filetype: "m4a" })).toBe(true);
    expect(isAudioFile({ name: "PTT-20260915-WA0004.ogg" })).toBe(true);
    expect(isAudioFile({ mimetype: "image/png", name: "shot.png" })).toBe(false);
  });
});

describe("which client a workspace is", () => {
  it("matches the client name or a short alias inside the workspace name, whole words only", () => {
    expect(clientForWorkspaceName("Abela Clinic", clients)?.id).toBe("abela");
    expect(clientForWorkspaceName("TED x MangoEyes", clients)?.id).toBe("ted");
    expect(clientForWorkspaceName("The Eye Doctor", clients)?.id).toBe("ted");
    expect(clientForWorkspaceName("Tedious Ltd", clients)).toBeNull();
    expect(clientForWorkspaceName("MangoEyes", clients)).toBeNull();
  });
});

describe("a message from a client workspace", () => {
  it("carries the person's name, the tagged names and the transcript", () => {
    const m = slackToMessage(
      { type: "message", channel: "C1", user: "U7", text: "<@U1> the form is down", ts: "1757900000.000100", files: [{ name: "clip.m4a", mimetype: "audio/mp4" }] },
      { teamId: "T1", homeTeamId: "T0", clients: [{ ...clients[0], slackTeamId: "T1" }, clients[1]], senderIsStaff: false, senderName: "Dr Mehta", intakeChannelId: null, workspaceUrl: "https://abela.slack.com", userNames: { U1: "Renu" }, transcript: "please also check the prices" },
    );
    expect(m.clientId).toBe("abela");
    expect(m.sender).toBe("Dr Mehta");
    expect(m.text).toBe("@Renu the form is down\nplease also check the prices");
    expect(m.permalink).toBe("https://abela.slack.com/archives/C1/p1757900000000100");
    const raw = m.raw as { mentions: string[]; voice?: boolean; teamId: string };
    expect(raw.mentions).toEqual(["Renu"]);
    expect(raw.voice).toBe(true);
    expect(raw.teamId).toBe("T1");
  });
});

describe("reply reminders", () => {
  it("reads as one feed line, escalating with time", () => {
    expect(reminderHeadline({ clientName: "Abela", mins: 20, tagged: ["Renu"], words: "the booking form is down on mobile", source: "Slack, Dr Mehta" }))
      .toBe('💬 *Abela* · no reply for 20 min · tagged Renu · "the booking form is down on mobile" · Slack, Dr Mehta');
    expect(reminderHeadline({ clientName: "Abela", mins: 60, tagged: [], words: "x", source: "Slack, Dr Mehta" }).startsWith("⏰ *Abela* · no reply for 1 hour · \"x\"")).toBe(true);
    expect(reminderHeadline({ clientName: "Abela", mins: 1440, tagged: [], words: "x", source: "s" }).startsWith("🔴 *Abela* · no reply for 1 day")).toBe(true);
    expect(markLabel(2880)).toBe("2 days");
  });
  it("runs 20 min, 1 hour, 1 day, then daily until handled", () => {
    const marks = [20, 60, 1440];
    expect(nextMark(20, marks)).toBe(60);
    expect(nextMark(60, marks)).toBe(1440);
    expect(nextMark(1440, marks)).toBe(2880);
    expect(nextMark(2880, marks)).toBe(4320);
    expect(markLabel(4320)).toBe("3 days");
  });
  it("understands an acknowledgement typed in the thread", () => {
    for (const t of ["ack", "handled", "I replied", "done", "on it"]) expect(ACK_WORDS.test(t)).toBe(true);
    expect(ACK_WORDS.test("which client is this")).toBe(false);
  });
});
