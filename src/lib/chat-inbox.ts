/**
 * The "Task Hub Drop" space: where the team shares text and voice notes from the phone. Google only pushes a space
 * message to an app when the app is mentioned, so the hub reads the space itself every minute, as a person
 * (domain-wide delegation, scope chat.messages.readonly), and hands each new message to the same handler as a DM.
 *
 * Bookkeeping: `chat_inbox_space` (the space, found by name among the spaces the app is in), `chat_inbox_since`
 * (create time of the last message handled; only newer ones are read, so nothing runs twice and the backlog from
 * before the hub started is never touched), `chat_inbox_last` (the last poll, for health and hub_status).
 */
import { sql } from "./db";
import { appSpaces, chat, chatAsUser, chatReader, gchatConfigured, inboxSpaceName, rememberInboxSpace } from "./gchat";
import { handleIntakeMessage } from "./chat-intake";
import type { ChatMessage } from "./gchat-events";
import type { chat_v1 } from "googleapis";

export const inboxConfigured = () => gchatConfigured() && !!chatReader();

/** The registered Drop space, or the space of that name the app is a member of (registered on first sight). */
export async function inboxSpace(): Promise<string | null> {
  const r = await sql()`select value from settings where key = 'chat_inbox_space'`;
  if (r.length && r[0].value) return String(r[0].value);
  if (!gchatConfigured()) return null;
  const want = inboxSpaceName().toLowerCase();
  const hit = (await appSpaces()).find((s) => s.spaceType === "SPACE" && s.displayName.trim().toLowerCase() === want);
  if (!hit) return null;
  await rememberInboxSpace(hit.name);
  return hit.name;
}

/**
 * Read as a person, the API gives a sender only as `users/<id>`; read as the app, the members list carries display
 * names. Map one to the other, refreshed every 10 minutes.
 */
let _names: { at: number; space: string; map: Map<string, string> } | null = null;
export async function memberNames(space: string): Promise<Map<string, string>> {
  if (_names && _names.space === space && Date.now() - _names.at < 10 * 60_000) return _names.map;
  const map = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const res = await chat().spaces.members.list({ parent: space, pageSize: 500, pageToken });
    for (const mem of res.data.memberships ?? []) if (mem.member?.name && mem.member.displayName) map.set(mem.member.name, mem.member.displayName);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  _names = { at: Date.now(), space, map };
  return map;
}

/** A Chat API message as the DM handler expects it. */
export function toChatMessage(m: chat_v1.Schema$Message, names: Map<string, string> = new Map()): ChatMessage {
  const who = m.sender?.displayName ?? (m.sender?.name ? names.get(m.sender.name) : undefined) ?? undefined;
  return {
    name: m.name ?? "", thread: m.thread?.name ? { name: m.thread.name } : undefined, text: m.text ?? "", argumentText: m.argumentText ?? m.text ?? "",
    createTime: m.createTime ?? undefined, sender: { displayName: who, name: m.sender?.name ?? undefined },
    attachment: (m.attachment ?? []).map((a) => ({ name: a.name ?? undefined, contentName: a.contentName ?? undefined, contentType: a.contentType ?? undefined, attachmentDataRef: a.attachmentDataRef?.resourceName ? { resourceName: a.attachmentDataRef.resourceName } : undefined })),
  };
}

/** Messages newer than `since`, oldest first, people only (the hub's own replies are skipped). */
export function newHumanMessages(list: chat_v1.Schema$Message[], since: string): chat_v1.Schema$Message[] {
  return list
    .filter((m) => !!m.createTime && m.createTime > since && m.sender?.type !== "BOT")
    .sort((a, b) => String(a.createTime).localeCompare(String(b.createTime)));
}

export async function pollInbox(): Promise<{ space: string | null; read: number; handled: string[]; errors: string[] }> {
  const handled: string[] = [], errors: string[] = [];
  const report = async (r: { space: string | null; read: number; handled: string[]; errors: string[] }) => {
    try { await sql()`insert into settings (key, value) values ('chat_inbox_last', ${JSON.stringify({ at: new Date().toISOString(), ...r })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`; } catch { /* ignore */ }
    return r;
  };
  let space: string | null = null;
  try { space = await inboxSpace(); } catch (e) { return report({ space: null, read: 0, handled, errors: [`space: ${(e as Error).message.slice(0, 160)}`] }); }
  if (!space) return report({ space: null, read: 0, handled, errors: [`no space named "${inboxSpaceName()}" has the app as a member yet`] });

  const s = await sql()`select value from settings where key = 'chat_inbox_since'`;
  // First run: start now. Nothing shared before the hub began reading is picked up.
  const since = s.length && s[0].value ? String(s[0].value) : new Date().toISOString();
  if (!s.length) await sql()`insert into settings (key, value) values ('chat_inbox_since', ${JSON.stringify(since)}::jsonb) on conflict (key) do nothing`;

  let list: chat_v1.Schema$Message[] = [];
  try {
    const res = await chatAsUser().spaces.messages.list({ parent: space, pageSize: 50, orderBy: "createTime desc", filter: `createTime > "${since}"` });
    list = res.data.messages ?? [];
  } catch (e) {
    const msg = (e as Error).message;
    const hint = /unauthorized_client|invalid_grant|403|PERMISSION_DENIED/.test(msg) ? ` (is chat.messages.readonly authorised for the service account in the Admin console, and is ${chatReader()} a member of the space?)` : "";
    return report({ space, read: 0, handled, errors: [`list: ${msg.slice(0, 200)}${hint}`] });
  }
  const fresh = newHumanMessages(list, since);
  let names = new Map<string, string>();
  if (fresh.length) { try { names = await memberNames(space); } catch (e) { errors.push(`members: ${(e as Error).message.slice(0, 120)}`); } }
  let last = since;
  for (const m of fresh) {
    try {
      const cm = toChatMessage(m, names);
      await handleIntakeMessage(cm, { inbox: m }, space);
      handled.push(`${cm.sender?.displayName ?? m.sender?.name ?? "?"}: ${(m.text ?? "").slice(0, 40)}${m.attachment?.length ? ` [+${m.attachment.length} file]` : ""}`);
    } catch (e) { errors.push(`${m.name}: ${(e as Error).message.slice(0, 160)}`); }
    // Advance even on error: a message that fails is retried by the watchdog if it was stored, never re-read here.
    if (m.createTime && m.createTime > last) last = m.createTime;
  }
  if (last !== since) await sql()`update settings set value = ${JSON.stringify(last)}::jsonb, updated_at = now() where key = 'chat_inbox_since'`;
  return report({ space, read: fresh.length, handled, errors });
}
