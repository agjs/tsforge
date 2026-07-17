import type { EditGuard, IEditVeto } from "../tools/tool-context";

/**
 * BoringStack edit guard: reject a PURE deletion of `features.*` translation
 * keys from a locale `common.json`.
 *
 * The build model repeatedly wrote proper locale keys (error/confirm/success
 * strings, form-field labels) and then DELETED them to clear the boringstack
 * `i18n-locale-keys-used` "unused key" check — instead of wiring them into the
 * UI. That ships a hollow app (a list-only page, no form/confirm/toasts) and
 * churns. Prompt guidance alone did not stop it, so this is a hard, snapshot-free
 * guard: it compares only the single edit's before/after (never a saved tree). A
 * rename/restructure (removes some keys AND adds others) is allowed; only a pure
 * deletion of feature translations is blocked, forcing the model to wire them up.
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

    // Malformed before-content (rare) — can't compute a delta; fail OPEN.
    const beforeKeys = featureLeafKeys(before);

    if (beforeKeys === null) {
      return null;
    }

    const authored = authoredByFile.get(file) ?? new Set<string>();
    // Destructive = removing a key THIS SESSION authored (and not re-adding it).
    // Pre-existing keys are absent from `authored`, so their removal is allowed.
    const removed = [...beforeKeys].filter((k) => !afterKeys.has(k));
    const destructive = removed.filter((k) => authored.has(k));

    if (destructive.length > 0) {
      return {
        reason: "i18n-destructive-delete",
        message: destructiveLocaleRejection(file, destructive),
      };
    }

    // Accepted edit: record newly-added keys as session-authored, and forget any
    // that were legitimately removed, so state tracks the file's live key set.
    for (const k of afterKeys) {
      if (!beforeKeys.has(k)) {
        authored.add(k);
      }
    }

    for (const k of removed) {
      authored.delete(k);
    }

    authoredByFile.set(file, authored);

    return null;
  };
}
