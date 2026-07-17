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
    `key(s) you authored (${shown}${more}) and adds none. Do NOT delete translations ` +
    `to clear the \`i18n-locale-keys-used\` "unused" check — that ships a hollow app ` +
    `(a list-only page with no form, confirmation, or success/error messages). WIRE ` +
    `THEM UP instead: build the UI that uses them — form field labels, the create/edit/` +
    `delete buttons, the delete confirmation, and success/error toasts rendered via ` +
    `t("features.<entity>.<key>"). Keep the keys; add the code that references them.`
  );
}

/** The boringstack {@link EditGuard}: vetoes a pure deletion of locale feature
 *  keys, and vetoes an edit that leaves the locale file as invalid JSON. A no-op
 *  for any non-locale file or any edit that also adds keys.
 *
 *  Vetoing invalid-JSON-after is what closes the two-edit bypass a reviewer
 *  found: without it, the model could (1) delete keys AND malform the JSON in one
 *  edit — fail-open lets it through — then (2) repair the JSON without the keys.
 *  Rejecting step (1)'s malformed result blocks the sequence at the source; a
 *  locale file must always be valid JSON anyway (the gate would fail it too). */
export const boringstackEditGuard: EditGuard = (
  file: string,
  before: string,
  after: string
): IEditVeto | null => {
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

  const beforeKeys = featureLeafKeys(before);

  // Pre-existing malformed before-content (rare) — cannot reason about removals;
  // fail OPEN rather than block on state this guard didn't create.
  if (beforeKeys === null) {
    return null;
  }

  const removed = [...beforeKeys].filter((k) => !afterKeys.has(k));
  const added = [...afterKeys].filter((k) => !beforeKeys.has(k));

  // Allow when nothing is removed, or when at least as many keys are added as
  // removed (a balanced rename/refactor). Veto a NET key loss — this closes the
  // "add one throwaway key to license deleting the rest" bypass: deleting 20 keys
  // while adding 1 is removed(20) > added(1) → vetoed. Cross-feature masking is
  // caught too, since the delta is over all `features.*` keys, not one entity.
  if (removed.length === 0 || added.length >= removed.length) {
    return null;
  }

  return {
    reason: "i18n-destructive-delete",
    message: destructiveLocaleRejection(file, removed),
  };
};
