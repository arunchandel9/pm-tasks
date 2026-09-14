import { describe, it, expect } from "vitest";
import { resolveClientFromText, stripClientPrefix } from "../src/lib/resolve";
import type { Client } from "../src/lib/types";

const c = (id: string, name: string, extra: Partial<Client> = {}): Client => ({
  id, name, scope: "client", slackChannels: [], emailDomains: [], whatsappNumbers: [], boards: {}, clientFacingAck: false, aliases: [], ...extra,
});
const clients = [
  c("clinic-x", "Clinic X", { emailDomains: ["clinicx.co.uk"], whatsappNumbers: ["+44 7700 900123"], aliases: ["Dr Patel", "the clinic"] }),
  c("house", "House of Health", { emailDomains: ["houseofhealth.com"] }),
  c("internal", "MangoEyes internal", { scope: "internal" }),
];

describe("resolve client from pasted text", () => {
  it("prefix", () => expect(resolveClientFromText("Clinic X: booking button broken", clients)?.how).toBe("prefix"));
  it("bracket prefix with alias", () => expect(resolveClientFromText("[Dr Patel] can we update the FAQ", clients)?.client.id).toBe("clinic-x"));
  it("name anywhere", () => expect(resolveClientFromText("WhatsApp from House of Health: hero image stretched", clients)?.client.id).toBe("house"));
  it("email domain from a pasted email", () => expect(resolveClientFromText("From: Priya <priya@clinicx.co.uk>\nHi, can you swap the hero image", clients)?.how).toBe("email_domain"));
  it("whatsapp number", () => expect(resolveClientFromText("+447700900123: hi, the form isn't sending", clients)?.how).toBe("whatsapp_number"));
  it("unknown", () => expect(resolveClientFromText("someone said the site is slow", clients)).toBeNull());
  it("tells a bare client name from a short ask", async () => {
    const { isNameOnly } = await import("../src/lib/resolve");
    const ted = c("ted", "The Eye Doctor", { aliases: ["TED", "Eye Doctor"] });
    for (const t of ["TED", "ted", "The Eye Doctor", "this is for TED", "client: The Eye Doctor", "Eye Doctor please"]) expect(isNameOnly(t, ted), t).toBe(true);
    for (const t of ["TED: update the footer hours", "TED fix popup", "The Eye Doctor site is down", "HOH"]) expect(isNameOnly(t, ted), t).toBe(false);
  });
  it("alias only as a whole word, never inside another word", () => {
    const withTed = [...clients, c("ted", "The Eye Doctor", { aliases: ["TED", "Eye Doctor"] })];
    expect(resolveClientFromText("the reviews need to be reported and deleted", withTed)).toBeNull();
    expect(resolveClientFromText("TED: fix the footer", withTed)?.client.id).toBe("ted");
    expect(resolveClientFromText("call from the eye doctor today", withTed)?.client.id).toBe("ted");
  });
  it("never resolves to internal", () => expect(resolveClientFromText("MangoEyes internal: idea for the newsletter", clients)).toBeNull());
  it("strips the prefix", () => expect(stripClientPrefix("Clinic X: booking button broken", clients[0])).toBe("booking button broken"));
});

describe("fuzzy client match for voice transcripts", () => {
  it("accepts misheard names and rejects unrelated words", async () => {
    const { fuzzyClientFromText } = await import("../src/lib/resolve");
    const clients = [
      { id: "abela", name: "Abela", scope: "client", aliases: [], slackChannels: [], emailDomains: [], whatsappNumbers: [], boards: {}, clientFacingAck: false },
      { id: "ted", name: "The Eye Doctor", scope: "client", aliases: ["TED"], slackChannels: [], emailDomains: [], whatsappNumbers: [], boards: {}, clientFacingAck: false },
    ] as unknown as import("../src/lib/types").Client[];
    expect(fuzzyClientFromText("a bella needs new homepage images", clients)?.client.id).toBe("abela");
    expect(fuzzyClientFromText("for Abella please change the hero", clients)?.client.id).toBe("abela");
    expect(fuzzyClientFromText("the eye doctors footer hours", clients)?.client.id).toBe("ted");
    expect(fuzzyClientFromText("the homepage images are not good", clients)).toBeNull();
    // Short aliases never fuzz: "skin" is not Skyn, "and" is not Anil, "reported" is not TED.
    const short = [...clients, c("skynology", "Skynology", { aliases: ["Skyn"] }), c("dranil", "Dr Anil", { aliases: ["Anil"] })];
    expect(fuzzyClientFromText("the skin page and the reviews need to be reported", short)).toBeNull();
  });
});

describe("correcting a misheard name", () => {
  it("rewrites the matched words to the client name", async () => {
    const { correctName } = await import("../src/lib/resolve");
    expect(correctName("Abell Replace home page images.", "abell", "Abela")).toBe("Abela Replace home page images.");
    expect(correctName("for a bella please change the hero", "a bella", "Abela")).toBe("for Abela please change the hero");
  });
});
