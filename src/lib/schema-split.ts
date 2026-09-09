/** Turn schema SQL into individual statements: drop comments (full-line and trailing), then split on ';'. */
export function splitSchema(sqlText: string): string[] {
  const noComments = sqlText.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).filter((l) => l.trim()).join("\n");
  return noComments.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
}
