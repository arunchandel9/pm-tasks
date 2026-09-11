import { describe, it, expect } from "vitest";

describe("WhatsApp voice notes", () => {
  it("are audio by name even without an extension", async () => {
    const { isAudio, sniffAudio } = await import("../src/lib/transcribe");
    expect(isAudio("application/octet-stream", "PTT-20260911-WA0014")).toBe(true);
    expect(isAudio("application/octet-stream", "AUD-20260911-WA0003")).toBe(true);
    expect(isAudio("application/octet-stream", "IMG-20260911-WA0001")).toBe(false);
    expect(sniffAudio(Buffer.from("OggS\0\0\0\0", "latin1"))).toBe("ogg");
    expect(sniffAudio(Buffer.from("RIFF....WAVE", "latin1"))).toBe("wav");
    expect(sniffAudio(Buffer.from("\x89PNG", "latin1"))).toBeNull();
  });
});
