import { join, basename, isAbsolute, relative } from "node:path";
import type { ITask } from "../../spec";
import type { ErrorSet } from "../../validate";
import type { IMetaRuleViolation } from "../../meta-rules";
import { isInScope, isVendored } from "../../lib/scope";
import { readFiles } from "../../lib/fs";
import { ruleHelp, idiomHints } from "../feedback/rule-docs";
import {
  metaRuleHelp,
  renderMetaViolations,
} from "../feedback/meta-rule-feedback";

/** Cap rendered source lines so a large error set can't wall the model. */
const FEEDBACK_MAX_LINES = 20;

/**
 * Gate failures the model can act on (its editable files), each rendered WITH
 * its location and the offending source line — so the model fixes the exact
 * spot instead of reading the file and hand-counting to find it (which it did
 * for 3 turns on `money` when feedback was message-only). Plus the rules' fix
 * examples. Async because it reads the source lines from disk.
 */
export async function gateFeedback(
  errors: ErrorSet,
  task: ITask,
  cwd: string,
  metaViolations: readonly IMetaRuleViolation[] = [],
  vendored: readonly string[] = []
): Promise<string> {
  const own = errors.filter((e) => {
    if (e.file === undefined) {
      return true;
    }

    // A VENDORED file is read-only even though a whole-repo scope glob ("**/*")
    // technically matches it — tsc type-checks vendored files (eslint ignores
    // them), so a wrong CALL SITE can surface a TS error located INSIDE one. Never
    // show those as the model's to fix; they go in the read-only note and resolve
    // once the call site is correct. This is the leak that had the model trying to
    // "fix" types in vendored SDK files it cannot edit.
    const rel = (
      isAbsolute(e.file) ? relative(cwd, e.file) : e.file
    ).replaceAll("\\", "/");

    if (isVendored(rel, vendored) || isVendored(basename(e.file), vendored)) {
      return false;
    }

    return (
      isInScope(e.file, task.files) || isInScope(basename(e.file), task.files)
    );
  });
  const readOnly = errors.length - own.length;

  const list =
    own.length > 0
      ? await renderErrors(own.slice(0, FEEDBACK_MAX_LINES), cwd)
      : "(no failures in your editable files)";
  const capped =
    own.length > FEEDBACK_MAX_LINES
      ? `\n… and ${own.length - FEEDBACK_MAX_LINES} more — fix the above first.`
      : "";

  const note =
    readOnly > 0
      ? `\n(${readOnly} other error(s) are in read-only files — not yours to fix; they resolve once your files are correct.)`
      : "";

  const help = ruleHelp(own);
  const helpBlock =
    help.length > 0 ? `\n\nHow to satisfy the gate:\n${help}` : "";

  const sources = await readFiles(cwd, task.files);
  const idioms = idiomHints(
    sources.map((s) => s.content),
    own
  );
  const idiomBlock =
    idioms.length > 0 ? `\n\nWatch for these strict-TS idioms:\n${idioms}` : "";

  // Render meta-rule violations (project structure violations)
  const metaViolationsList =
    metaViolations.length > 0 ? renderMetaViolations(metaViolations) : "";
  const metaBlock =
    metaViolationsList.length > 0
      ? `\n\n## Project structure\n${metaViolationsList}`
      : "";

  const metaHelp = metaRuleHelp(metaViolations);
  const metaHelpBlock = metaHelp.length > 0 ? `\n${metaHelp}` : "";

  // Tool-use lapse guard: if an editable file doesn't exist, the model likely
  // wrote the code as message TEXT instead of calling `create`. Code in your
  // reply is NEVER applied — only tool calls touch disk. Say so explicitly.
  const present = new Set(sources.map((s) => s.path));
  const missing = task.files.filter((f) => !present.has(f));
  const missingBlock =
    missing.length > 0
      ? `\n\n⚠ These editable files do NOT exist yet: ${missing.join(", ")}. ` +
        "Code written in your message text is NOT applied — you MUST call the " +
        "`create` tool with the file path and full content."
      : "";

  return `The acceptance command still fails:\n${list}${capped}${note}${helpBlock}${idiomBlock}${metaBlock}${metaHelpBlock}${missingBlock}\n\nFix your editable files and run it again.`;
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
