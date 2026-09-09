import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { gmail, gmailConfigured, mailbox, intakeAddress, parseMail } from "@/lib/gmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proves the mailbox connection: who the hub reads as, and the last 5 mails to the intake address as the hub
 * would parse them (sender, forward detection, first lines). Nothing is processed or labelled.
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://pm-tasks.vercel.app/api/gmail-check
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (!gmailConfigured()) return NextResponse.json({ ok: false, error: "GMAIL_MAILBOX or GOOGLE_SERVICE_ACCOUNT_B64 not set" }, { status: 500 });
  try {
    const g = gmail();
    const profile = (await g.users.getProfile({ userId: "me" })).data;
    const addr = intakeAddress();
    const list = await g.users.messages.list({ userId: "me", q: `${addr ? `to:${addr} ` : ""}newer_than:7d -in:spam -in:trash`, maxResults: 5 });
    const mails = [];
    for (const m of list.data.messages ?? []) {
      const p = parseMail((await g.users.messages.get({ userId: "me", id: m.id!, format: "full" })).data);
      mails.push({ subject: p.subject, from: p.from, isForward: p.isForward, originalFrom: p.originalFrom, date: p.date, note: p.note.slice(0, 120), body: p.body.slice(0, 200) });
    }
    return NextResponse.json({ ok: true, readsAs: mailbox(), intakeAddress: addr, profileEmail: profile.emailAddress, messagesTotal: profile.messagesTotal, recent: mails });
  } catch (e) {
    const msg = (e as Error).message;
    const hint = /unauthorized_client|invalid_grant|Not Authorized|403/.test(msg)
      ? "Domain-wide delegation is missing or the GMAIL_MAILBOX is not a real user (an alias cannot be impersonated)."
      : /404|Requested entity was not found/.test(msg) ? "That user does not exist in the Workspace." : undefined;
    return NextResponse.json({ ok: false, readsAs: mailbox(), error: msg.slice(0, 300), hint }, { status: 500 });
  }
}
