/**
 * Hashline format constants and pure functions. Single source of truth for
 * read/edit annotation format, hash computation, and display helpers.
 * Adapts oh-my-pi's hashline primitives for tsforge (no block-edits,
 * lenient parse, 3-way merge recovery).
 */

/** File-section header prefix. */
export const HL_HEADER_SIGIL = "¶";

/** Hash separator in header: `¶path#HASH`. */
export const HL_HASH_SEP = "#";

/** Line-number / content separator: `N:text`. */
export const HL_LINE_SEP = ":";

/** Replacement/deletion/insert operation keywords. */
export const HL_OP_REPLACE = "replace";
export const HL_OP_DELETE = "delete";
export const HL_OP_INSERT = "insert";

/** Position keywords for insert. */
export const HL_POS_BEFORE = "before";
export const HL_POS_AFTER = "after";

/** Payload line prefix. */
export const HL_PAYLOAD_PREFIX = "+";

/** Range separator: N..M. */
export const HL_RANGE_SEP = "..";

/** Length of the hex hash (4 hex chars = 16 bits). */
export const HL_HASH_LENGTH = 4;

/**
 * Normalize text for hashing: strip trailing [ \t\r] from every line
 * (before \n or EOF) so CRLF and display-trimmed content hash identically.
 */
function normalizeForHash(text: string): string {
  return text.replace(/[ \t\r]+(?=\n|$)/g, "");
}

/**
 * Compute the content-derived hash tag for a file's normalized text.
 * 4-hex-uppercase fingerprint using xxHash32 (fast, collision-free for
 * practical file sizes). Same tag mints on every read of byte-identical content.
 */
export function computeFileHash(text: string): string {
  const normalized = normalizeForHash(text);
  const hash32 = Bun.hash.xxHash32(normalized, 0);
  const low16 = hash32 & 0xffff;

  return low16.toString(16).padStart(HL_HASH_LENGTH, "0").toUpperCase();
}

/**
 * Format a read-annotation header: `¶path#HASH`.
 */
export function formatHashHeader(filePath: string, hash: string): string {
  return `${HL_HEADER_SIGIL}${filePath}${HL_HASH_SEP}${hash}`;
}

/**
 * Format a numbered line: `N:text`.
 */
export function formatNumberedLine(lineNum: number, text: string): string {
  return `${lineNum}${HL_LINE_SEP}${text}`;
}

/**
 * Parse a read-annotation header. Extracts path and hash from `¶path#HASH`.
 * Returns null if the line is not a valid header.
 */
export function parseHashHeader(
  line: string
): { path: string; hash: string } | null {
  if (!line.startsWith(HL_HEADER_SIGIL)) {
    return null;
  }

  const body = line.slice(HL_HEADER_SIGIL.length);
  const sepIdx = body.lastIndexOf(HL_HASH_SEP);

  if (sepIdx === -1) {
    return null;
  }

  const path = body.slice(0, sepIdx);
  const hash = body.slice(sepIdx + 1);

  if (path.length === 0 || !isValidHash(hash)) {
    return null;
  }

  return { path, hash };
}

/**
 * Check if a string is a valid 4-hex hash.
 */
export function isValidHash(hash: string): boolean {
  return /^[0-9A-F]{4}$/i.test(hash);
}

/**
 * Normalize a hash to uppercase for comparison.
 */
export function normalizeHash(hash: string): string {
  return hash.toUpperCase();
}
