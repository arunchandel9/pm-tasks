import { NextResponse } from "next/server";
import { sql, databaseUrl } from "@/lib/db";
import { pulp } from "@/lib/pulp";
import { sheetsConfigured } from "@/lib/sheets";
import { env } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = { model: env.model(), pulp: pulp.configured(), sheets: sheetsConfigured(), slack: !!process.env.SLACK_BOT_TOKEN, intakePaused: env.intakePaused(), cronSecretSet: !!process.env.CRON_SECRET, dbUrlSet: !!databaseUrl(), anthropicKeySet: !!process.env.ANTHROPIC_API_KEY };
  try {
    const r = await sql()`select count(*)::int as clients from clients`;
    out.db = { ok: true, clients: r[0].clients };
  } catch (e) {
    out.db = { ok: false, error: (e as Error).message };
  }
  return NextResponse.json(out);
}
