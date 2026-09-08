/** Turn schema SQL into individual statements: drop full-line comments first, then split on ';'. */
export function splitSchema(sqlText: string): string[] {
  const noComments = sqlText.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
  return noComments.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
}
