import { google } from "googleapis";

/**
 * Voice notes → text, with Google Speech-to-Text (same service account as Sheets and Chat).
 * Synchronous recognition handles up to ~60 seconds, which covers almost every WhatsApp voice note.
 * Longer notes come back as `tooLong` and go to review as "needs a person".
 */
export async function transcribeAudio(buf: Buffer, contentType: string, fileName = ""): Promise<{ text: string } | { tooLong: true } | { error: string }> {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64) return { error: "GOOGLE_NOT_CONFIGURED" };
  const credentials = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const speech = google.speech({ version: "v1p1beta1", auth });

  const ct = contentType.toLowerCase(), fn = fileName.toLowerCase();
  let encoding: string | undefined, sampleRateHertz: number | undefined;
  if (ct.includes("ogg") || ct.includes("opus") || fn.endsWith(".ogg") || fn.endsWith(".opus")) { encoding = "OGG_OPUS"; sampleRateHertz = 16000; }
  else if (ct.includes("mpeg") || ct.includes("mp3") || fn.endsWith(".mp3")) { encoding = "MP3"; sampleRateHertz = 44100; }
  else if (ct.includes("webm")) { encoding = "WEBM_OPUS"; sampleRateHertz = 48000; }
  // wav/flac/m4a: let the service infer from the header

  try {
    const res = await speech.speech.recognize({
      requestBody: {
        config: { encoding, sampleRateHertz, languageCode: "en-GB", alternativeLanguageCodes: ["en-IN", "en-US"], enableAutomaticPunctuation: true, model: "latest_long" },
        audio: { content: buf.toString("base64") },
      },
    });
    const text = (res.data.results ?? []).map((r) => r.alternatives?.[0]?.transcript ?? "").join(" ").trim();
    return { text };
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/too long|exceeds|longer than|duration/i.test(msg)) return { tooLong: true };
    return { error: msg };
  }
}

export const isAudio = (contentType: string, fileName = "") =>
  /^audio\//i.test(contentType) || /\.(ogg|opus|mp3|m4a|wav|flac|webm|aac|amr)$/i.test(fileName);
