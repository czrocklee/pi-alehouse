/** UTF-16 result-page boundaries only; cursor identity, range validation and
 * settled/live eligibility remain with the Owner. A requested page may grow
 * by one unit to keep a surrogate pair together, unlike prefix retention. */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[offset] ?? "")
  );
}

/** Caller supplies an already-validated offset and positive page limit. No
 * cursor parsing, retained-result lookup, mutation or truncation policy here. */
export function sliceResultWindow(
  text: string,
  offset: number,
  limit: number,
): { text: string; end: number } {
  let end = Math.min(text.length, offset + limit);
  if (splitsSurrogatePair(text, end)) end++;
  return { text: text.slice(offset, end), end };
}
