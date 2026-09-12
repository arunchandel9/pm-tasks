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
  });
});
