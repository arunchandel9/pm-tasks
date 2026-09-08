/** Bearer check for cron and setup routes. Tolerates surrounding whitespace on either side. */
export function cronAuthorized(req: Request): boolean {
  const expected = (process.env.CRON_SECRET ?? "").trim();
  if (!expected) return false;
  const header = (req.headers.get("authorization") ?? "").trim();
  const given = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header;
  return given === expected;
}
