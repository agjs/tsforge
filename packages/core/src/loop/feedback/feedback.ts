import { join, basename, isAbsolute, relative } from "node:path";
import type { ITask } from "../../spec";
import type { ErrorSet } from "../../validate";
import type { IMetaRuleViolation } from "../../meta-rules";
import { isInScope } from "../../lib/scope";
import { readFiles } from "../../lib/fs";
import { ruleHelp, idiomHints } from "../feedback/rule-docs";
import {
  metaRuleHelp,
  renderMetaViolations,
} from "../feedback/meta-rule-feedback";
import { formatGateIdentity } from "../gate-visibility";

/** Cap rendered source lines so a large error set can't wall the model. */
const FEEDBACK_MAX_LINES = 20;

/** Cap rendered instances PER RULE. The 4th repeat of the same rule teaches
 *  the model nothing the first 3 didn't; without this, one project-wide rule
 *  sweep (e.g. 30× no-explicit-any) walls the entire feedback budget and the
 *  model never hears about the OTHER rules it also violated. */
const FEEDBACK_MAX_PER_RULE = 3;

/** A scope glob describes a set of files, not one promised literal file. Treating
 * it as a missing pathname tells the model that existing generated files do not
 * exist and sends it into pointless create/read loops. */
function isLiteralPath(path: string): boolean {
  return !["*", "?", "[", "]", "{", "}"].some((char) => path.includes(char));
}

/**
 * Gate failures the model can act on (its editable files), each rendered WITH
 * its location and the offending source line — so the model fixes the exact
 * spot instead of reading the file and hand-counting to find it (which it did
 * for 3 turns on `money` when feedback was message-only). Plus the rules' fix
 * examples. Async because it reads the source lines from disk.
 *
 * `focusError` (R3 narrow): when set, filters the feedback to show ONLY the
 * single most-persistent error. The key format:
 *  - regular errors: "file:line:rule"
 *  - metaViolations: "file:ruleId"
 * CRITICAL: focusError filters ONLY the rendered feedback; the unfiltered error
 * set remains for fingerprinting/progress guards (compute those BEFORE filtering).
 */
export async function gateFeedback(
  errors: ErrorSet,
  task: ITask,
  cwd: string,
  metaViolations: readonly IMetaRuleViolation[] = [],
  focusError: string | null = null,
  packs: readonly string[] = []
): Promise<string> {
  const own = errors.filter((e) => isOwnError(e, cwd, task.files));
  const outOfScope = errors.filter((e) => !isOwnError(e, cwd, task.files));

  // R3 narrow: when a focus key is set, show ONLY the matching error — in WHICHEVER
  // partition it lives — so narrowing survives even when the sticky error sits in a
  // file the model can't edit. Never dump the whole other partition. CRITICAL: this
  // filters ONLY the rendered feedback; fingerprint/progress guards use the full set.
  const focus = (list: ErrorSet): ErrorSet =>
    focusError === null
      ? list
      : list.filter((e) => [e.file, e.line, e.rule].join(":") === focusError);
  const focusedOwn = focus(own);
  const focusedOut = focus(outOfScope);

  // ONE shared render budget across both partitions — never a 20-per-side, 40-line
  // wall. Editable errors come first (the model acts on them directly); locked-file
  // errors fill the remaining budget, the rest go to the overflow summary.
  const { shown, skipped } = selectRepresentative([
    ...focusedOwn,
    ...focusedOut,
  ]);
  const shownOwn = shown.filter((e) => isOwnError(e, cwd, task.files));
  const shownOut = shown.filter((e) => !isOwnError(e, cwd, task.files));
  const capped = overflowSummary(skipped);

  const noFocusMatch =
    focusError !== null && focusedOwn.length === 0 && focusedOut.length === 0;
  const list =
    shownOwn.length > 0
      ? await renderErrors(shownOwn, cwd)
      : noFocusMatch
        ? "(no errors matching the focused error key)"
        : "(no failures in your editable files)";

  const outOfScopeBlock =
    shownOut.length > 0
      ? `\n\n## Errors in files you cannot edit\nYou cannot edit these files. These ` +
        `failures may be a downstream consequence of your editable code — a locked ` +
        `file consumes a type or export you own. Read them, then fix the editable ` +
        `PRODUCER. Do NOT edit the files below.\n${await renderErrors(shownOut, cwd)}`
      : "";

  const help = ruleHelp([...focusedOwn, ...focusedOut]);
  const helpBlock =
    help.length > 0 ? `\n\nHow to satisfy the gate:\n${help}` : "";

  const sources = await readFiles(cwd, task.files);
  const idioms = idiomHints(
    sources.map((s) => s.content),
    own
  );
  const idiomBlock =
    idioms.length > 0 ? `\n\nWatch for these strict-TS idioms:\n${idioms}` : "";

  // R3 narrow: filter metaViolations to focused error only (if set).
  const renderedMetaViolations =
    focusError !== null
      ? metaViolations.filter((v) => {
          const key = `${v.file}:${v.ruleId}`;

          return key === focusError;
        })
      : metaViolations;

  // Render meta-rule violations (project structure violations)
  const metaViolationsList =
    renderedMetaViolations.length > 0
      ? renderMetaViolations(renderedMetaViolations)
      : "";
  const metaBlock =
    metaViolationsList.length > 0
      ? `\n\n## Project structure\n${metaViolationsList}`
      : "";

  const metaHelp = metaRuleHelp(renderedMetaViolations);
  const metaHelpBlock = metaHelp.length > 0 ? `\n${metaHelp}` : "";

  // Tool-use lapse guard: if an editable file doesn't exist, the model likely
  // wrote the code as message TEXT instead of calling `create`. Code in your
  // reply is NEVER applied — only tool calls touch disk. Say so explicitly.
  const present = new Set(sources.map((s) => s.path));
  const missing = task.files.filter(
    (file) => isLiteralPath(file) && !present.has(file)
  );
  const missingBlock =
    missing.length > 0
      ? `\n\n⚠ These editable files do NOT exist yet: ${missing.join(", ")}. ` +
        "Code written in your message text is NOT applied — you MUST call the " +
        "`create` tool with the file path and full content."
      : "";

  const identity = formatGateIdentity(task.accept, packs);

  // Always-present remaining count, computed from the UNFILTERED sets (before
  // focus). Every lead-in that wraps this body (near-green banner, anti-patch,
  // rotation steer) may omit the total, and focus mode hides all but one error —
  // this line is the one place the model can always read how many remain.
  const totalErrors = errors.length;
  const metaPart =
    metaViolations.length > 0
      ? ` + ${metaViolations.length} project-structure violation(s)`
      : "";
  const focusShown = focusedOwn.length + focusedOut.length;
  const countLine =
    focusError !== null && focusShown > 0
      ? `${totalErrors} error(s) remaining — showing ${focusShown} of ` +
        `${totalErrors} (focused on the most persistent error; fix it first).`
      : `${totalErrors} error(s)${metaPart} remaining.`;

  return `The acceptance command still fails:\n${identity}\n\n${countLine}\n${list}${capped}${outOfScopeBlock}${helpBlock}${idiomBlock}${metaBlock}${metaHelpBlock}${missingBlock}\n\nFix your editable files and run it again.`;
}

/**
 * Is this gate error in a file the model may edit (in `task.files` scope)? An error
 * with no file is treated as "own" (opaque command signatures belong to the model).
 * eslint emits ABSOLUTE paths, so normalize to workspace-relative before matching;
 * the basename fallback catches path-shape mismatches.
 */
function isOwnError(
  e: ErrorSet[number],
  cwd: string,
  files: string[]
): boolean {
  if (e.file === undefined) {
    return true;
  }

  const rel = (isAbsolute(e.file) ? relative(cwd, e.file) : e.file).replaceAll(
    "\\",
    "/"
  );

  return isInScope(rel, files) || isInScope(basename(e.file), files);
}

/**
 * Pick the errors worth rendering in full: keep parser emission order (tsc
 * first — type errors gate everything else), but cap instances per rule so a
 * single noisy rule can't spend the whole FEEDBACK_MAX_LINES budget. Errors
 * without a rule id (generic/oracle output) are never capped per-rule — each
 * one is distinct signal.
 */
function selectRepresentative(errors: ErrorSet): {
  shown: ErrorSet;
  skipped: ErrorSet;
} {
  const shown: ErrorSet = [];
  const skipped: ErrorSet = [];
  const perRule = new Map<string, number>();

  for (const e of errors) {
    const count = e.rule === undefined ? 0 : (perRule.get(e.rule) ?? 0);
    const ruleCapped = e.rule !== undefined && count >= FEEDBACK_MAX_PER_RULE;

    if (shown.length < FEEDBACK_MAX_LINES && !ruleCapped) {
      shown.push(e);

      if (e.rule !== undefined) {
        perRule.set(e.rule, count + 1);
      }
    } else {
      skipped.push(e);
    }
  }

  return { shown, skipped };
}

/**
 * Summarize the errors we did NOT render, grouped by rule with counts and the
 * affected files — "12 more [no-explicit-any] in a.ts, b.ts" tells the model
 * the shown fix applies elsewhere too, at a fraction of the token cost of
 * rendering every instance.
 */
function overflowSummary(skipped: ErrorSet): string {
  if (skipped.length === 0) {
    return "";
  }

  const byRule = new Map<string, { count: number; files: Set<string> }>();

  for (const e of skipped) {
    const key = e.rule ?? "other";
    const entry = byRule.get(key) ?? { count: 0, files: new Set<string>() };

    entry.count += 1;

    if (e.file !== undefined) {
      entry.files.add(basename(e.file));
    }

    byRule.set(key, entry);
  }

  const lines = [...byRule.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([rule, { count, files }]) => {
      const names = [...files];
      const shownFiles = names.slice(0, 3).join(", ");
      const extra = names.length > 3 ? ` (+${names.length - 3} files)` : "";
      const where = names.length > 0 ? ` in ${shownFiles}${extra}` : "";
      // "other" is the bucket for errors with no rule id (generic/oracle output);
      // render it as prose so the model doesn't read it as a rule named `other`.
      const label = rule === "other" ? "unclassified errors" : `[${rule}]`;

      return `  - ${count} more ${label}${where}`;
    });

  return `\n… plus ${skipped.length} more not shown — same rules, same fixes apply:\n${lines.join("\n")}`;
}

/**
 * Render each error as `- file:line [rule] message` followed by the offending
 * source line, so the model sees the exact code to change. Reads each file once
 * (cached); falls back to the bare message when there's no location.
 */
async function renderErrors(errors: ErrorSet, cwd: string): Promise<string> {
  const sources = new Map<string, string[]>();

  const linesOf = async (file: string): Promise<string[]> => {
    const cached = sources.get(file);

    if (cached !== undefined) {
      return cached;
    }

    const abs = isAbsolute(file) ? file : join(cwd, file);
    const handle = Bun.file(abs);
    const lines = (await handle.exists())
      ? (await handle.text()).split("\n")
      : [];

    sources.set(file, lines);

    return lines;
  };

  const rendered: string[] = [];

  for (const e of errors) {
    const loc =
      e.file !== undefined && e.line !== undefined
        ? `${basename(e.file)}:${e.line} `
        : "";
    const rule = e.rule !== undefined ? `[${e.rule}] ` : "";
    const head = `- ${loc}${rule}${e.message}`;

    if (e.file !== undefined && e.line !== undefined) {
      const src = (await linesOf(e.file))[e.line - 1];

      if (src !== undefined && src.trim().length > 0) {
        rendered.push(`${head}\n      ${e.line} │ ${src.trim()}`);
        continue;
      }
    }

    rendered.push(head);
  }

  return rendered.join("\n");
}
