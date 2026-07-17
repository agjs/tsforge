import type { EditGuard, IEditVeto } from "../tools/tool-context";

/**
 * BoringStack edit guard: block the model from DELETING `features.*` translation
 * keys it authored earlier this build (to clear the `i18n-locale-keys-used`
 * "unused key" check) instead of wiring them into the UI — which ships a hollow
 * app (a list-only page, no form/confirm/toasts) and churns.
 *
 * Stateful, per-build (see {@link makeBoringstackEditGuard}): it tracks the
 * feature keys THIS session has written (via edit/edit_lines/create) per locale
 * file, and vetoes an edit whose NET loss of session-authored keys is positive
 * (more authored keys removed than keys added). That blocks a wholesale gut while
 * ALLOWING a balanced rename/restructure (remove one authored key, add its
 * replacement) — so the now-unused old key never deadlocks the gate. Pre-existing
 * / scaffold keys are never tracked, so removing a genuinely obsolete key is fine.
 *
 * This is a BoringStack overlay — the core edit tool stays domain-agnostic and
 * calls whatever {@link EditGuard} is injected via the tool context.
 */

/** A boringstack locale message file whose `features.*` keys this guard protects.
 *  Requires a path boundary before `i18n` so it can't match `…myi18n/locales/…`. */
export function isLocaleCommonJson(file: string): boolean {
  return /(?:^|\/)i18n\/locales\/[^/]+\/common\.json$/u.test(file);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Every string-valued leaf path under the top-level `features` object, e.g.
 *  `contact.title`, `deal.createError`. Other namespaces are ignored (a feature
 *  build owns only its `features.<entity>` surface). Returns `null` when the
 *  content is not parseable JSON, so callers can fail OPEN rather than mistake an
 *  unparseable version for "all keys removed". */
function featureLeafKeys(content: string): Set<string> | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  const keys = new Set<string>();

  if (!isRecord(parsed) || !isRecord(parsed.features)) {
    return keys;
  }

  collectLeafPaths(parsed.features, "", keys);

  return keys;
}

function collectLeafPaths(
  node: Record<string, unknown>,
  prefix: string,
  out: Set<string>
): void {
  for (const [k, v] of Object.entries(node)) {
    const path = prefix === "" ? k : `${prefix}.${k}`;

    if (typeof v === "string") {
      out.add(path);
    } else if (isRecord(v)) {
      collectLeafPaths(v, path, out);
    }
  }
}

/** The model-facing rejection: names the deleted keys, points at wiring up. */
function destructiveLocaleRejection(
  file: string,
  removed: readonly string[]
): string {
  const shown = removed.slice(0, 8).join(", ");
  const more =
    removed.length > 8 ? `, +${String(removed.length - 8)} more` : "";

  return (
    `edit ${file} REJECTED: this edit DELETES ${String(removed.length)} translation ` +
    `key(s) YOU added earlier this build (${shown}${more}). Do NOT delete translations ` +
    `you authored to clear the \`i18n-locale-keys-used\` "unused" check — that ships a ` +
    `hollow app ` +
    `(a list-only page with no form, confirmation, or success/error messages). WIRE ` +
    `THEM UP instead: build the UI that uses them — form field labels, the create/edit/` +
    `delete buttons, the delete confirmation, and success/error toasts rendered via ` +
    `t("features.<entity>.<key>"). Keep the keys; add the code that references them.`
  );
}

/**
 * Build a stateful boringstack {@link EditGuard}. It tracks, per locale file, the
 * feature keys the SESSION has authored (added via a prior accepted edit), and
 * vetoes a later edit that DELETES one of those session-authored keys — the exact
 * destructive pattern (write a translation, then delete it to clear the unused
 * check). It also vetoes an edit that leaves the locale file as invalid JSON.
 *
 * Authorship state is the fix for over-blocking: PRE-EXISTING keys (scaffold-
 * seeded, or another feature's) are NOT tracked, so removing a genuinely obsolete
 * key is allowed and the gate can never deadlock. It also removes the need for the
 * gameable count heuristic — each key is judged by whether this session wrote it.
 *
 * Vetoing invalid-JSON-after closes a two-edit bypass: delete keys AND malform the
 * JSON in one edit (fail-open), then repair without the keys. A locale file must
 * always parse, so rejecting the malformed result blocks the sequence at step 1.
 *
 * Call once per build (the state must persist across the build's edits) and pass
 * the result as the Session's `editGuard`.
 *
 * KNOWN LIMITATION (architectural, not closeable here): the `run` shell tool can
 * write any file directly (`bun -e`, `sed -i`, a script), bypassing ALL edit-tool
 * guards — this one and scope enforcement alike. Closing that needs run-write
 * interception, a separate concern from this per-edit guard.
 */
export function makeBoringstackEditGuard(): EditGuard {
  const authoredByFile = new Map<string, Set<string>>();

  return (file: string, before: string, after: string): IEditVeto | null => {
    if (!isLocaleCommonJson(file)) {
      return null;
    }

    const afterKeys = featureLeafKeys(after);

    if (afterKeys === null) {
      return {
        reason: "i18n-invalid-json",
        message:
          `edit ${file} REJECTED: this edit left the locale file as invalid JSON. ` +
          `Fix the JSON syntax and KEEP every feature translation key — do not drop ` +
          `keys while "cleaning up". A locale file must always parse.`,
      };
    }

    const authored = authoredByFile.get(file) ?? new Set<string>();
    const beforeKeys = featureLeafKeys(before);

    // A NEW file (empty before — e.g. `create` seeding the locale vocabulary):
    // every key is written this session, so record them all as authored. This
    // closes the create→gut bypass (keys added via create are now tracked, so a
    // later edit that deletes them is caught).
    if (before.trim() === "") {
      for (const k of afterKeys) {
        authored.add(k);
      }

      authoredByFile.set(file, authored);

      return null;
    }

    // Non-empty but unparseable before (rare) — can't compute a delta; fail OPEN
    // without recording (uncertain baseline; not state this guard created).
    if (beforeKeys === null) {
      return null;
    }

    const removed = [...beforeKeys].filter((k) => !afterKeys.has(k));
    const added = [...afterKeys].filter((k) => !beforeKeys.has(k));
    // Destructive = a NET loss of keys THIS SESSION authored. Removing an authored
    // key is fine if the edit adds at least as many keys (a rename/restructure —
    // no deadlock on the now-unused old key); a wholesale gut (remove many
    // authored, add few) is vetoed. Pre-existing keys aren't authored, so their
    // removal never counts.
    const authoredRemoved = removed.filter((k) => authored.has(k));

    if (authoredRemoved.length > added.length) {
      return {
        reason: "i18n-destructive-delete",
        message: destructiveLocaleRejection(file, authoredRemoved),
      };
    }

    // Accepted edit: record newly-added keys as session-authored, and forget any
    // that were legitimately removed, so state tracks the file's live key set.
    for (const k of added) {
      authored.add(k);
    }

    for (const k of removed) {
      authored.delete(k);
    }

    authoredByFile.set(file, authored);

    return null;
  };
}
