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

/** Length of the hex hash minted today (8 hex chars = full 32 bits). Was 4
 *  (16 bits, 65 536 values): the hashline engine addresses edits by LINE
 *  NUMBER and trusts this hash as the SOLE check that the file is unchanged, so
 *  a ~1/65 536 collision on a concurrently-edited file spliced line ops into
 *  DIFFERENT content — a silent wrong-location apply. 32 bits makes that
 *  ~1/4 billion. A legacy 4-hex hash (from a pre-widening persisted transcript
 *  the model pastes back) still VALIDATES but won't equal a fresh 8-hex live
 *  hash, so it routes to the safe stale/re-anchor path rather than a false match. */
export const HL_HASH_LENGTH = 8;

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
  // `>>> 0` keeps it an unsigned 32-bit int (xxHash32 can return negative under
  // JS bit ops); 8 hex chars, zero-padded.
  const hash32 = Bun.hash.xxHash32(normalized, 0) >>> 0;

  return hash32.toString(16).padStart(HL_HASH_LENGTH, "0").toUpperCase();
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
 * Check if a string is a valid hash: 8 hex (minted today) or 4 hex (legacy,
 * still accepted so a pre-widening header pasted from an old transcript parses
 * — it simply won't match a fresh 8-hex live hash and routes to stale recovery).
 */
export function isValidHash(hash: string): boolean {
  return /^(?:[0-9A-F]{8}|[0-9A-F]{4})$/i.test(hash);
}

/**
 * Normalize a hash to uppercase for comparison.
 */
export function normalizeHash(hash: string): string {
  return hash.toUpperCase();
}

/**
 * Extract the 4-hex hash from a raw value that may be a full `¶path#HASH` tag,
 * a `path#HASH`, a `#HASH`, or a bare `HASH`. The model frequently pastes the
 * whole header tag (what it saw on read) into the `hash` arg, which then fails
 * the staleness compare against a real 4-hex hash. Returns undefined when no
 * valid hash is present.
 */
export function extractHash(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const candidate = raw.includes(HL_HASH_SEP)
    ? raw.slice(raw.lastIndexOf(HL_HASH_SEP) + 1).trim()
    : raw.trim();

  return isValidHash(candidate) ? candidate : undefined;
}
