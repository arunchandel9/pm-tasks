import { google, type chat_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";

/**
 * Google Chat: the team-facing side of the hub. Two spaces: PM Review (drafts, acks, alerts, summary)
 * and Intake (paste WhatsApp text, drop voice notes, /task form). One service account, same as Sheets.
 */

function credentials() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("GOOGLE_NOT_CONFIGURED");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

let _chat: chat_v1.Chat | null = null;
export function chat(): chat_v1.Chat {
  if (!_chat) {
    const auth = new google.auth.GoogleAuth({ credentials: credentials(), scopes: ["https://www.googleapis.com/auth/chat.bot"] });
    _chat = google.chat({ version: "v1", auth });
  }
  return _chat;
}

/** Where Google Chat calls us. In add-on style apps a button's `function` must be this URL, with the handler name as ?fn=. */
export const endpointUrl = () => (process.env.GCHAT_ENDPOINT_URL || "https://pm-tasks.vercel.app/api/gchat").replace(/\/$/, "");
export const fnRef = (name: string) => `${endpointUrl()}?fn=${encodeURIComponent(name)}`;
/** Recover the handler name from an invokedFunction that may be a bare name or our URL form. */
export function fnName(invoked: string | null | undefined): string {
  if (!invoked) return "";
  const m = invoked.match(/[?&]fn=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : invoked;
}

export const gchatConfigured = () => !!process.env.GOOGLE_SERVICE_ACCOUNT_B64 && !!process.env.GCHAT_REVIEW_SPACE && !!process.env.GOOGLE_PROJECT_NUMBER;
export const reviewSpace = () => normSpace(process.env.GCHAT_REVIEW_SPACE ?? "");
export const intakeSpace = () => normSpace(process.env.GCHAT_INTAKE_SPACE ?? "");
function normSpace(s: string): string {
  s = s.trim();
  if (!s) return "";
  return s.startsWith("spaces/") ? s : `spaces/${s}`;
}

/**
 * Every request from Google Chat carries a JWT signed by Google. Audience is the project number (classic apps) or
 * the endpoint URL (add-on style apps); the caller is Chat's system account or, for add-on deployments, the
 * Workspace add-ons service agent. Returns the reason on failure so /api/health can show it.
 */
export async function verifyChatRequest(authHeader: string | null, calledUrl?: string): Promise<{ ok: boolean; reason?: string; caller?: string }> {
  const projectNumber = process.env.GOOGLE_PROJECT_NUMBER;
  if (!projectNumber) return { ok: false, reason: "GOOGLE_PROJECT_NUMBER not set" };
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, reason: "no bearer token" };
  const audiences = [projectNumber, endpointUrl()];
  if (calledUrl) { try { const u = new URL(calledUrl); audiences.push(calledUrl, `${u.origin}${u.pathname}`); } catch { /* ignore */ } }
  try {
    const client = new OAuth2Client();
    const ticket = await client.verifyIdToken({ idToken: authHeader.slice(7), audience: audiences });
    const p = ticket.getPayload();
    const email = p?.email ?? "";
    const trusted = email === "chat@system.gserviceaccount.com" || /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/.test(email);
    if (!trusted || p?.email_verified !== true) return { ok: false, reason: `caller not trusted: ${email || "(no email)"} aud=${String(p?.aud)}`, caller: email };
    return { ok: true, caller: email };
  } catch (e) {
    return { ok: false, reason: `jwt: ${(e as Error).message.slice(0, 200)}` };
  }
}

// ---- sending ----

export async function sendText(space: string, text: string, threadName?: string): Promise<string | null> {
  const res = await chat().spaces.messages.create({
    parent: space,
    messageReplyOption: threadName ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : undefined,
    requestBody: { text, thread: threadName ? { name: threadName } : undefined },
  });
  return res.data.name ?? null;
}

export async function sendCard(space: string, card: chat_v1.Schema$GoogleAppsCardV1Card, fallbackText: string, cardId: string): Promise<string | null> {
  const res = await chat().spaces.messages.create({
    parent: space,
    requestBody: { text: fallbackText, cardsV2: [{ cardId, card }] },
  });
  return res.data.name ?? null;
}

export async function updateMessageText(messageName: string, text: string): Promise<void> {
  await chat().spaces.messages.patch({ name: messageName, updateMask: "text,cardsV2", requestBody: { text, cardsV2: [] } });
}

export async function downloadAttachment(resourceName: string): Promise<Buffer> {
  const res = await chat().media.download({ resourceName, alt: "media" }, { responseType: "arraybuffer" });
  return Buffer.from(res.data as ArrayBuffer);
}

// ---- card builders (Cards v2) ----

type Btn = { text: string; fn: string; params: Record<string, string>; primary?: boolean; danger?: boolean };

function buttons(list: Btn[]): chat_v1.Schema$GoogleAppsCardV1Widget {
  return {
    buttonList: {
      buttons: list.map((b) => ({
        text: b.text,
        onClick: { action: { function: fnRef(b.fn), parameters: Object.entries(b.params).map(([key, value]) => ({ key, value })) } },
        color: b.primary ? { red: 0.16, green: 0.48, blue: 0.35, alpha: 1 } : b.danger ? { red: 0.7, green: 0.2, blue: 0.2, alpha: 1 } : undefined,
      })),
    },
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function draftCard(p: {
  requestId: string; clientName: string; scopeTag: string; department: string; priority: string; gated: boolean;
  confidence: number; title: string; firstLine: string; quote: string; source: string; permalink: string | null; reason: string; pulpLine: string;
}): chat_v1.Schema$GoogleAppsCardV1Card {
  const src = p.permalink ? `<a href="${p.permalink}">${esc(p.source)}</a>` : esc(p.source);
  return {
    header: { title: `${p.clientName}${p.scopeTag} · ${p.department} · ${p.priority}${p.gated ? " · Needs scope" : ""}`, subtitle: `confidence ${p.confidence.toFixed(2)} · ${p.source}` },
    sections: [{
      widgets: [
        { decoratedText: { topLabel: "Draft task", text: `<b>${esc(p.title)}</b>`, wrapText: true } },
        { textParagraph: { text: esc(p.firstLine) } },
        { textParagraph: { text: `<i>"${esc(p.quote.slice(0, 300))}"</i>` } },
        { textParagraph: { text: `${src} · ${esc(p.reason)} · ${esc(p.pulpLine)}` } },
        buttons([
          { text: "Approve", fn: "approve", params: { requestId: p.requestId }, primary: true },
          { text: "Edit", fn: "edit", params: { requestId: p.requestId } },
          { text: "Merge into…", fn: "merge", params: { requestId: p.requestId } },
          { text: "Not a task", fn: "dismiss", params: { requestId: p.requestId }, danger: true },
        ]),
      ],
    }],
  };
}

export function needsHumanCard(p: { messageId: string; clientName: string; why: string; text: string; source: string; permalink: string | null; clients: Array<{ id: string; name: string }> }): chat_v1.Schema$GoogleAppsCardV1Card {
  const src = p.permalink ? `<a href="${p.permalink}">${esc(p.source)}</a>` : esc(p.source);
  const widgets: chat_v1.Schema$GoogleAppsCardV1Widget[] = [
    { textParagraph: { text: `<i>"${esc(p.text.slice(0, 400) || "(no text)")}"</i>` } },
    { textParagraph: { text: `${src} · ${esc(p.why.replace(/_/g, " "))}` } },
  ];
  if (p.clients.length) {
    widgets.push({
      selectionInput: {
        name: "client", label: "Which client?", type: "DROPDOWN",
        items: p.clients.map((c) => ({ text: c.name, value: c.id, selected: false })),
        onChangeAction: { function: fnRef("pick_client"), parameters: [{ key: "messageId", value: p.messageId }] },
      },
    });
  }
  widgets.push(buttons([
    { text: "Make it a task", fn: "make_task", params: { messageId: p.messageId }, primary: true },
    { text: "Not a task", fn: "dismiss_message", params: { messageId: p.messageId }, danger: true },
  ]));
  return { header: { title: `${p.clientName} · needs a person`, subtitle: p.why.replace(/_/g, " ") }, sections: [{ widgets }] };
}

export function duplicateCard(p: { requestId: string; duplicateOf: string; clientName: string; label: string; text: string; source: string; permalink: string | null }): chat_v1.Schema$GoogleAppsCardV1Card {
  const src = p.permalink ? `<a href="${p.permalink}">${esc(p.source)}</a>` : esc(p.source);
  return {
    header: { title: `${p.clientName} · ${p.label}`, subtitle: `of request ${p.duplicateOf.slice(0, 8)}` },
    sections: [{
      widgets: [
        { textParagraph: { text: `<i>"${esc(p.text.slice(0, 300))}"</i>` } },
        { textParagraph: { text: src } },
        buttons([
          { text: "Merge into it", fn: "merge_into", params: { requestId: p.requestId, into: p.duplicateOf }, primary: true },
          { text: "Separate task", fn: "approve", params: { requestId: p.requestId } },
          { text: "Not a task", fn: "dismiss", params: { requestId: p.requestId }, danger: true },
        ]),
      ],
    }],
  };
}

/** The /task dialog body: client dropdown, request text, notes, priority. Wrapped per event format by the route. */
export function taskDialogBody(clients: Array<{ id: string; name: string }>) {
  return {
            header: { title: "Add a request" },
            sections: [{
              widgets: [
                { selectionInput: { name: "client", label: "Client", type: "DROPDOWN", items: clients.map((c, i) => ({ text: c.name, value: c.id, selected: i === 0 })) } },
                { textInput: { name: "request", label: "What was asked (the client's words, as close as possible)", type: "MULTIPLE_LINE" } },
                { textInput: { name: "notes", label: "Notes for the team (optional)", type: "MULTIPLE_LINE" } },
                { selectionInput: { name: "priority", label: "Priority", type: "RADIO_BUTTON", items: [
                  { text: "Normal", value: "P3", selected: true }, { text: "Important", value: "P2", selected: false }, { text: "Urgent (P1)", value: "P1", selected: false },
                ] } },
                { textInput: { name: "source", label: "Where it came from (WhatsApp, phone, email…) (optional)", type: "SINGLE_LINE" } },
                { buttonList: { buttons: [{ text: "Add request", onClick: { action: { function: fnRef("submit_task") } } }] } },
              ],
            }],
  };
}
