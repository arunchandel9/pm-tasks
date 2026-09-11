import { google } from "googleapis";
import { Readable } from "node:stream";

/**
 * Voice notes → text, with Google Speech-to-Text (same service account as Sheets and Chat).
 *  - Up to ~60 seconds: synchronous recognition, result in seconds.
 *  - Longer (WhatsApp notes are often 5–20 minutes): the audio is uploaded to a bucket in the project and a
 *    long-running recognition is started; the minute tick polls it (queue job `transcribe_poll`) and, when done,
 *    processes the text like a typed message. Audio stays in the bucket (keep-everything policy).
 */

function credentials() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("GOOGLE_NOT_CONFIGURED");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { project_id: string; client_email: string };
}
function auth() {
  return new google.auth.GoogleAuth({ credentials: credentials(), scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
}
const speech = () => google.speech({ version: "v1p1beta1", auth: auth() });
const storage = () => google.storage({ version: "v1", auth: auth() });

/**
 * Speech-to-Text v2 (Chirp): decodes the file itself (no encoding or sample-rate guessing) and handles accents far
 * better than v1. Regional; SPEECH_LOCATION defaults to us-central1 where chirp_3 is offered. Sync limit: 60 s / 10 MB.
 */
async function recognizeV2(buf: Buffer, model: string): Promise<string> {
  const location = process.env.SPEECH_LOCATION || "us-central1";
  const project = credentials().project_id;
  const client = await auth().getClient();
  const token = (await client.getAccessToken()).token;
  const res = await fetch(`https://${location}-speech.googleapis.com/v2/projects/${project}/locations/${location}/recognizers/_:recognize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      config: { autoDecodingConfig: {}, languageCodes: [process.env.SPEECH_LANGUAGE || "en-IN"], model, features: { enableAutomaticPunctuation: true } },
      content: buf.toString("base64"),
    }),
  });
  if (!res.ok) throw new Error(`speech v2 ${model} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { results?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  return (data.results ?? []).map((r) => r.alternatives?.[0]?.transcript ?? "").join(" ").trim();
}

/** WhatsApp voice notes arrive as "PTT-20260911-WA0014" (no extension) or "AUD-…"; Chat often labels them octet-stream. */
const WHATSAPP_VOICE = /^(PTT|AUD)-\d{8}-WA\d+/i;
export const isAudio = (contentType: string, fileName = "") =>
  /^audio\//i.test(contentType) || /ogg|opus/i.test(contentType) || /\.(ogg|opus|mp3|m4a|wav|flac|webm|aac|amr)$/i.test(fileName) || WHATSAPP_VOICE.test(fileName);

/** Look at the first bytes: "OggS" (ogg/opus), "ID3" or an MPEG frame (mp3), "RIFF" (wav), "fLaC". Null when unknown. */
export function sniffAudio(buf: Buffer): "ogg" | "mp3" | "wav" | "flac" | null {
  if (buf.length < 4) return null;
  const head = buf.subarray(0, 4).toString("latin1");
  if (head === "OggS") return "ogg";
  if (head.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "mp3";
  if (head === "RIFF") return "wav";
  if (head === "fLaC") return "flac";
  return null;
}

/** The Opus header inside an Ogg file carries the original sample rate; Google needs the matching value or it mishears. */
export function opusInputRate(buf: Buffer): number | null {
  const i = buf.subarray(0, 512).indexOf("OpusHead", 0, "latin1");
  if (i < 0 || i + 16 > buf.length) return null;
  const rate = buf.readUInt32LE(i + 12);
  const allowed = [8000, 12000, 16000, 24000, 48000];
  return allowed.includes(rate) ? rate : allowed.reduce((a, b) => (Math.abs(b - rate) < Math.abs(a - rate) ? b : a));
}

function encodingFor(contentType: string, fileName: string, sampleRateHertz?: number, buf?: Buffer) {
  const ct = contentType.toLowerCase(), fn = fileName.toLowerCase();
  const sniffed = buf ? sniffAudio(buf) : null;
  if (sniffed === "ogg" || ct.includes("ogg") || ct.includes("opus") || fn.endsWith(".ogg") || fn.endsWith(".opus") || WHATSAPP_VOICE.test(fileName)) return { encoding: "OGG_OPUS", sampleRateHertz: sampleRateHertz ?? (buf ? opusInputRate(buf) : null) ?? 16000 };
  if (sniffed === "mp3") return { encoding: "MP3", sampleRateHertz: sampleRateHertz ?? 44100 };
  if (ct.includes("mpeg") || ct.includes("mp3") || fn.endsWith(".mp3")) return { encoding: "MP3", sampleRateHertz: sampleRateHertz ?? 44100 };
  if (ct.includes("webm")) return { encoding: "WEBM_OPUS", sampleRateHertz: sampleRateHertz ?? 48000 };
  return {}; // wav/flac/m4a: the service reads the header
}
// British English with Indian and American alternatives (en-IN as primary with latest_long returns nothing on some notes).
const baseConfig = { languageCode: "en-GB", alternativeLanguageCodes: ["en-IN", "en-US"], enableAutomaticPunctuation: true, model: "latest_long" };
const plainConfig = { languageCode: "en-IN", enableAutomaticPunctuation: true }; // last resort: default model, one language
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const isTooLong = (msg: string) => /too long|exceeds|longer than|duration|LongRunningRecognize/i.test(msg);
const isRateIssue = (msg: string) => /sample rate|sample_rate/i.test(msg);

/** What happened to the last voice note: engine, audio length, words, errors. Read on /api/health as voice_last. */
async function noteVoice(d: Record<string, unknown>) {
  try {
    const { sql } = await import("./db");
    await sql()`insert into settings (key, value) values ('voice_last', ${JSON.stringify({ at: new Date().toISOString(), ...d })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch { /* diagnostics only */ }
}

/** Short notes: instant. Returns `tooLong` when the service refuses the length, so the caller can go the long way. */
export async function transcribeAudio(buf: Buffer, contentType: string, fileName = ""): Promise<{ text: string } | { tooLong: true } | { error: string }> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_B64) return { error: "GOOGLE_NOT_CONFIGURED" };
  const diag: Record<string, unknown> = { file: fileName, contentType, bytes: buf.length, sniff: sniffAudio(buf), opusRate: opusInputRate(buf), errors: [] as string[] };
  const attempt = async (rate?: number, config: Record<string, unknown> = baseConfig) => {
    const res = await speech().speech.recognize({
      requestBody: { config: { ...encodingFor(contentType, fileName, rate, buf), ...config }, audio: { content: buf.toString("base64") } },
    });
    return (res.data.results ?? []).map((r) => r.alternatives?.[0]?.transcript ?? "").join(" ").trim();
  };
  const seconds = buf.length / (/(mp3|mpeg)/i.test(contentType) ? 16_000 : 2_000);
  // First choice: v2 with Chirp, then v2's long model. Both decode the file themselves. v1 below is the fallback.
  diag.seconds = Math.round(seconds);
  if (seconds <= 58 && buf.length < 9_000_000 && process.env.SPEECH_V2 !== "off") {
    for (const model of [process.env.SPEECH_MODEL || "chirp_3", "long"]) {
      try {
        const t = await recognizeV2(buf, model);
        if (words(t)) { await noteVoice({ ...diag, engine: `v2:${model}`, words: words(t), text: t.slice(0, 120) }); return { text: t }; }
        (diag.errors as string[]).push(`v2:${model}: empty`);
      } catch (e) { (diag.errors as string[]).push(`v2:${model}: ${(e as Error).message.slice(0, 160)}`); }
    }
  }
  try {
    let text = await attempt();
    // A few words out of many seconds of audio means the rate was wrong: try the other common Opus rate, keep the longer.
    if (seconds > 6 && words(text) < 4 && sniffAudio(buf) === "ogg") {
      const first = opusInputRate(buf) ?? 16000;
      try { const again = await attempt(first === 48000 ? 16000 : 48000); if (words(again) > words(text)) text = again; } catch { /* keep the first */ }
    }
    if (seconds > 3 && !words(text)) {
      try { const plain = await attempt(undefined, plainConfig); if (words(plain) > words(text)) text = plain; } catch { /* keep what we have */ }
    }
    await noteVoice({ ...diag, engine: "v1", words: words(text), text: text.slice(0, 120) });
    if (!text) return { error: "no speech recognised" };
    return { text };
  } catch (e) {
    const msg = (e as Error).message || "";
    (diag.errors as string[]).push(`v1: ${msg.slice(0, 160)}`);
    await noteVoice({ ...diag, engine: "none" });
    if (isTooLong(msg)) return { tooLong: true };
    if (isRateIssue(msg)) { try { return { text: await attempt(48000) }; } catch (e2) { return { error: (e2 as Error).message }; } }
    return { error: msg };
  }
}

// ---- long notes ----

function bucketName(): string {
  return process.env.VOICE_BUCKET || `${credentials().project_id}-task-hub-voice`;
}

/** Create the bucket once if the service account may; otherwise the error names what a person has to create. */
async function ensureBucket(): Promise<string> {
  const name = bucketName();
  try {
    await storage().buckets.get({ bucket: name });
    return name;
  } catch (e) {
    if (!/404|notFound/i.test((e as Error).message)) throw e;
  }
  await storage().buckets.insert({
    project: credentials().project_id,
    requestBody: { name, location: process.env.VOICE_BUCKET_LOCATION || "ASIA-SOUTH1", storageClass: "STANDARD", iamConfiguration: { uniformBucketLevelAccess: { enabled: true } } },
  });
  return name;
}

export interface LongJob { operation: string; gsUri: string; contentType: string; fileName: string; rate?: number }

/** Upload the audio and start a long-running recognition. Returns what the poll job needs. */
export async function startLongTranscription(buf: Buffer, contentType: string, fileName = "", rate?: number): Promise<LongJob> {
  const bucket = await ensureBucket();
  const safe = (fileName || "voice-note").replace(/[^\w.\-]+/g, "_");
  const object = `voice/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${safe}`;
  await storage().objects.insert({ bucket, name: object, media: { mimeType: contentType || "application/octet-stream", body: Readable.from(buf) } });
  const gsUri = `gs://${bucket}/${object}`;
  const res = await speech().speech.longrunningrecognize({
    requestBody: { config: { ...encodingFor(contentType, fileName, rate, buf), ...baseConfig }, audio: { uri: gsUri } },
  });
  if (!res.data.name) throw new Error("longrunningrecognize returned no operation name");
  return { operation: res.data.name, gsUri, contentType, fileName, rate };
}

/** Check a long-running recognition. `done:false` means ask again in a minute. */
export async function pollLongTranscription(job: LongJob): Promise<{ done: false } | { done: true; text: string } | { done: true; error: string }> {
  const op = await speech().operations.get({ name: job.operation });
  if (!op.data.done) return { done: false };
  if (op.data.error) return { done: true, error: op.data.error.message ?? "recognition failed" };
  const results = ((op.data.response as { results?: Array<{ alternatives?: Array<{ transcript?: string }> }> } | undefined)?.results) ?? [];
  return { done: true, text: results.map((r) => r.alternatives?.[0]?.transcript ?? "").join(" ").trim() };
}

/** Rough length estimate from the bytes, for the "received" line only: Opus voice notes run about 2 KB per second. */
export const estimateMinutes = (bytes: number, contentType: string) => Math.max(1, Math.round(bytes / (/(mp3|mpeg)/i.test(contentType) ? 120_000 : 2_000) / 60));
