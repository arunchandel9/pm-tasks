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

export const isAudio = (contentType: string, fileName = "") =>
  /^audio\//i.test(contentType) || /\.(ogg|opus|mp3|m4a|wav|flac|webm|aac|amr)$/i.test(fileName);

function encodingFor(contentType: string, fileName: string, sampleRateHertz?: number) {
  const ct = contentType.toLowerCase(), fn = fileName.toLowerCase();
  if (ct.includes("ogg") || ct.includes("opus") || fn.endsWith(".ogg") || fn.endsWith(".opus")) return { encoding: "OGG_OPUS", sampleRateHertz: sampleRateHertz ?? 16000 };
  if (ct.includes("mpeg") || ct.includes("mp3") || fn.endsWith(".mp3")) return { encoding: "MP3", sampleRateHertz: sampleRateHertz ?? 44100 };
  if (ct.includes("webm")) return { encoding: "WEBM_OPUS", sampleRateHertz: sampleRateHertz ?? 48000 };
  return {}; // wav/flac/m4a: the service reads the header
}
const baseConfig = { languageCode: "en-GB", alternativeLanguageCodes: ["en-IN", "en-US"], enableAutomaticPunctuation: true, model: "latest_long" };
const isTooLong = (msg: string) => /too long|exceeds|longer than|duration|LongRunningRecognize/i.test(msg);
const isRateIssue = (msg: string) => /sample rate|sample_rate/i.test(msg);

/** Short notes: instant. Returns `tooLong` when the service refuses the length, so the caller can go the long way. */
export async function transcribeAudio(buf: Buffer, contentType: string, fileName = ""): Promise<{ text: string } | { tooLong: true } | { error: string }> {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_B64) return { error: "GOOGLE_NOT_CONFIGURED" };
  const attempt = async (rate?: number) => {
    const res = await speech().speech.recognize({
      requestBody: { config: { ...encodingFor(contentType, fileName, rate), ...baseConfig }, audio: { content: buf.toString("base64") } },
    });
    return (res.data.results ?? []).map((r) => r.alternatives?.[0]?.transcript ?? "").join(" ").trim();
  };
  try {
    return { text: await attempt() };
  } catch (e) {
    const msg = (e as Error).message || "";
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
    requestBody: { config: { ...encodingFor(contentType, fileName, rate), ...baseConfig }, audio: { uri: gsUri } },
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
