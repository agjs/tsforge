/** Pull a JSON object out of a fenced ```json block or raw text. */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);

  if (fenced?.[1] !== undefined) {
    return fenced[1];
  }

  const braced = /\{[\s\S]*\}/.exec(text);

  return braced?.[0] ?? text;
}
