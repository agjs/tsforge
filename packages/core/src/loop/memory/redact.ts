/**
 * Strip obvious secrets before retaining decision text into an external bank.
 * Fail closed on match: drop the line rather than send it.
 */

const SECRET_LINE =
  /(?:api[_-]?key|secret|password|token|authorization|bearer)\s*[:=]\s*\S+/iu;
const ENV_ASSIGNMENT = /^[A-Z][A-Z0-9_]*\s*=\s*\S+/u;
const SK_PREFIX = /\bsk-[a-zA-Z0-9]{16,}\b/u;

/** Return content with secret-shaped lines/tokens removed. */
export function redactForRetain(content: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    if (SECRET_LINE.test(line) || ENV_ASSIGNMENT.test(line.trim())) {
      continue;
    }

    kept.push(line.replace(SK_PREFIX, "[redacted]"));
  }

  return kept.join("\n").trim();
}
