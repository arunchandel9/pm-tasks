/**
 * One message from a person to the hub through Google Chat, however it arrived: a DM with the app (pushed by Google
 * to /api/gchat) or the "Task Hub Drop" space (read by the hub every minute, see chat-inbox.ts). Same rules either way:
 * client name from the text / the thread / a name given just before, voice notes transcribed, the sender is answered in
 * the message's own thread only when they must act or nothing was created; the feed carries the finals.
 */
import { allClients, sql } from "./db";
import { processMessage } from "./pipeline";
import { resolveClientFromText, fuzzyClientFromText, stripClientPrefix } from "./resolve";
import { postText, humanOutcome, closeNeedsHumanCard, messageThreadKey, askWhichClient, suggestedClientOf } from "./review";
import { transcribeAudio, isAudio, sniffAudio, startLongTranscription, estimateMinutes, hintPhrases } from "./transcribe";
import { isAcknowledgement, isAffirmative } from "./filter/noise";
import { noise } from "./config";
import { downloadAttachment, sendText } from "./gchat";
import type { ChatMessage } from "./gchat-events";
import type { Message } from "./types";

function permalinkFor(messageName: string): string | null {
  const m = messageName.match(/^spaces\/([^/]+)\/messages\/(.+)$/);
  return m ? `https://chat.google.com/room/${m[1]}/${m[2]}` : null;
}

export async function handleIntakeMessage(msg: ChatMessage, raw: unknown, space: string) {
  const clients = await allClients();
  let text = (msg.argumentText ?? msg.text ?? "").replace(/^@?Task Hub\s*/i, "").trim();
  const sender = msg.sender?.displayName ?? msg.sender?.email ?? "unknown";
  let transcriptNote = "";
  const say = (t: string) => sendText(space, t, msg.thread?.name).catch((e) => console.error("say failed", (e as Error).message));

  // A message that is only a client name ("HOH", "this is for PSS"), or a "yes" to the hub's suggestion: it names the
  // client for a message sent just before (same thread, or the last 30 minutes in a direct chat) or about to be sent (kept 15 min).
  const nameHit = resolveClientFromText(text, clients);
  const yes = !nameHit && isAffirmative(text);
  if (((nameHit && text.split(/\s+/).length <= 5) || yes) && !msg.attachment?.length) {
    const pending = await sql()`
      select id, raw from messages where channel = 'intake' and client_id is null and skip_reason in ('unknown_client', 'attachment_only')
        and (${msg.thread?.name ?? null}::text is not null and thread_ref = ${msg.thread?.name ?? null} or (${msg.thread?.name ?? null}::text is null and sender = ${sender} and created_at > now() - interval '30 minutes'))
      order by created_at desc limit 1`;
    const suggested = pending.length ? suggestedClientOf(pending[0].raw) : null;
    const chosen = nameHit?.client ?? (suggested ? clients.find((x) => x.id === suggested.id) ?? null : null);
    if (pending.length && chosen) {
      const id = String(pending[0].id);
      await sql()`update messages set client_id = ${chosen.id}, scope = ${chosen.scope}, skip_reason = null where id = ${id}`;
      await sql()`insert into queue (kind, payload) values ('process_message', ${JSON.stringify({ messageId: id })}::jsonb)`;
      await closeNeedsHumanCard(id, `👤 Client set to ${chosen.name} by ${sender}; processing.`);
      await say(`Got it: ${chosen.name}. Processing the message above.`);
      return;
    }
    if (nameHit) {
      await sql()`insert into settings (key, value) values (${"client_hint:" + sender}, ${JSON.stringify({ clientId: nameHit.client.id, at: Date.now() })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
      await say(`Noted: ${nameHit.client.name}. Forward the message now and I will file it under that client.`);
      return;
    }
  }

  // "ok thanks", "👍", "great": nothing to do and nothing to say. Stored as skipped so it is still on record.
  if (!msg.attachment?.length && isAcknowledgement(text, noise())) {
    await storeOnly(baseMessage(msg, raw, sender, text, clients), "acknowledgement");
    return;
  }

  for (const a of msg.attachment ?? []) {
    // Audio by type or name, or any non-image file whose first bytes say it is audio (WhatsApp notes come without an extension).
    if (!a.attachmentDataRef?.resourceName || /^image\//i.test(a.contentType ?? "")) continue;
    const namedAudio = isAudio(a.contentType ?? "", a.contentName ?? "");
    try {
      const buf = await downloadAttachment(a.attachmentDataRef.resourceName);
      if (!namedAudio && !sniffAudio(buf)) continue;
      const hints = hintPhrases(clients.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
      const t = await transcribeAudio(buf, a.contentType ?? "", a.contentName ?? "", hints);
      if ("text" in t && t.text) { text = [text, t.text].filter(Boolean).join("\n"); transcriptNote = " (voice note transcribed)"; }
      else if ("tooLong" in t) {
        // Long note: upload, start the long-running recognition, and let the minute tick finish the job.
        const mins = estimateMinutes(buf.length, a.contentType ?? "");
        try {
          const job = await startLongTranscription(buf, a.contentType ?? "", a.contentName ?? "", undefined, hints);
          const stored = await storeOnly({ ...baseMessage(msg, raw, sender, text, clients), text }, "transcribing");
          await sql()`insert into queue (kind, payload, next_run_at) values ('transcribe_poll', ${JSON.stringify({ messageId: stored.id, job, typed: text })}::jsonb, now() + interval '60 seconds')`;
          await postText(`🎙️ Voice note from ${sender} received (about ${mins} min). Transcribing; the task lines will follow in a few minutes.`, { threadKey: messageThreadKey(stored.id) });
          return;
        } catch (e) { transcriptNote = ` (long voice note could not be started: ${(e as Error).message.slice(0, 160)})`; }
      }
      else transcriptNote = ` (voice note could not be transcribed: ${"error" in t ? t.error : "unknown"})`;
    } catch (e) { transcriptNote = ` (voice note download failed: ${(e as Error).message})`; }
  }

  let m = baseMessage(msg, raw, sender, text, clients);
  if (transcriptNote) {
    m = { ...m, raw: { ...(m.raw as Record<string, unknown> | null ?? {}), voice: true } };
    if (!m.clientId) {
      // A name the recogniser may have misheard ("a bell" ~ Abela) is only a suggestion: the sender confirms it in the thread.
      const f = fuzzyClientFromText(text, clients);
      if (f) m = { ...m, raw: { ...(m.raw as Record<string, unknown>), suggestedClient: { id: f.client.id, name: f.client.name, heard: f.matched } } };
    }
  }
  if (!m.clientId && msg.thread?.name) {
    // A reply inside a thread belongs to that thread's client: "also broken on tablet" under the HOH forward is HOH.
    const root = await sql()`select client_id, scope from messages where thread_ref = ${msg.thread.name} and client_id is not null order by created_at asc limit 1`;
    if (root.length) m = { ...m, clientId: String(root[0].client_id), scope: root[0].scope as Message["scope"] };
  }
  if (!m.clientId) {
    // No client in the text: use the name the same person gave in the last 15 minutes, if any.
    const h = await sql()`select value from settings where key = ${"client_hint:" + sender}`;
    const hint = h.length ? (h[0].value as { clientId: string; at: number }) : null;
    const c = hint && Date.now() - hint.at < 15 * 60 * 1000 ? clients.find((x) => x.id === hint.clientId) : null;
    if (c) { m = { ...m, clientId: c.id, scope: c.scope }; await sql()`delete from settings where key = ${"client_hint:" + sender}`; }
  }
  const hit = m.clientId ? { client: clients.find((x) => x.id === m.clientId)! } : null;
  if (!m.text.trim() && !msg.attachment?.length) return;
  if (!m.text.trim()) {
    await storeOnly(m, "attachment_only");
    await say(`I can read text and voice notes, not images${transcriptNote}. Type what it asks for, with the client name.`);
    return;
  }
  const result = await processMessage(m, { skip: false, reason: null });
  const n = result.requestIds?.length ?? 0;
  // The DM answers only when the sender must act or nothing was created; the feed lines are the receipt for created tasks.
  if (result.outcome === "review" && result.reason === "unknown_client") {
    await say(askWhichClient({ text: m.text, raw: m.raw }));
    return;
  }
  const heard = transcriptNote ? `Heard: "${m.text.replace(/\s+/g, " ").slice(0, 200)}${m.text.length > 200 ? "…" : ""}"\n` : "";
  if ((result.outcome === "review" || result.outcome === "attached") && n) {
    // What happened to each ask: filed as a new card, or added to an existing card (merged). Say so only when it helps:
    // a voice note (so the words can be checked), a short or uncertain ask, or an attach (the feed line alone is easy to miss).
    const reqs = await sql()`
      select r.status, coalesce(mt.draft->>'title', r.draft->>'title') as title, r.confidence
      from requests r left join requests mt on mt.id = r.merged_into where r.id = any(${result.requestIds ?? []}::uuid[])`;
    // An "attached" outcome points at the card the reply was added to; its request is not merged, so treat all as added.
    const filed = result.outcome === "attached" ? [] : reqs.filter((r) => r.status !== "merged").map((r) => String(r.title));
    const added = result.outcome === "attached" ? reqs.map((r) => String(r.title)) : reqs.filter((r) => r.status === "merged").map((r) => String(r.title));
    const vague = m.text.trim().split(/\s+/).length < 10 || reqs.some((r) => Number(r.confidence) < 0.7);
    const parts = [filed.length ? `Filed: ${filed.join("; ")}.` : "", added.length ? `Added to the existing card: ${added.join("; ")}.` : ""].filter(Boolean).join(" ");
    if (result.outcome === "attached" && !reqs.length) { if (transcriptNote) await say(`${heard}Added to the existing card in this thread.`); return; }
    if (transcriptNote || vague || added.length) await say(`${heard}${parts} Reply here to correct or add anything.`);
    return;
  }
  await say(`Nothing created: ${humanOutcome(result.outcome, result.reason)}${transcriptNote}`);
}

/** The Message record for an Intake/DM post, with the client resolved from the text. */
function baseMessage(msg: ChatMessage, raw: unknown, sender: string, text: string, clients: Awaited<ReturnType<typeof allClients>>): Message {
  const hit = resolveClientFromText(text, clients);
  return {
    channel: "intake", externalId: msg.name, teamId: null, clientId: hit?.client.id ?? null, scope: hit ? hit.client.scope : "unknown",
    sender, senderIsStaff: true, sentAt: msg.createTime ? new Date(msg.createTime) : new Date(),
    text: hit ? stripClientPrefix(text, hit.client) : text, permalink: permalinkFor(msg.name), threadRef: msg.thread?.name ?? null, raw,
  };
}

async function storeOnly(m: Message, skipReason: string): Promise<{ id: string }> {
  const { textHash } = await import("@/lib/dedupe");
  const rows = await sql()`
    insert into messages (channel, external_id, client_id, scope, sender, sender_is_staff, sent_at, text, text_hash, permalink, thread_ref, raw, skip_reason)
    values (${m.channel}, ${m.externalId}, ${m.clientId}, ${m.scope}, ${m.sender}, ${m.senderIsStaff}, ${m.sentAt.toISOString()}, ${m.text}, ${textHash(m.text || m.externalId)}, ${m.permalink}, ${m.threadRef}, ${JSON.stringify(m.raw)}::jsonb, ${skipReason})
    on conflict (channel, external_id) do update set skip_reason = excluded.skip_reason returning id`;
  return { id: rows[0].id as string };
}
