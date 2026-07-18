import type { IToolContext } from "./tool-context";
import type { IErrorItem } from "../../validate/validate.types";

/** Cap the error list so a huge failure set can't blow the turn's context budget. */
const MAX_ERRORS = 200;

/** Cap raw gate output (surfaced only when the gate failed but parsed NO structured
 *  errors) so an unparsed failure blob can't blow the turn's context budget. */
const MAX_OUTPUT_CHARS = 4000;

/** One structured error as the model sees it — the actionable fields only. */
interface ICheckError {
  file?: string;
  line?: number;
  rule?: string;
  message: string;
}

function toStruct(e: IErrorItem): ICheckError {
  return {
    ...(e.file === undefined ? {} : { file: e.file }),
    ...(e.line === undefined ? {} : { line: e.line }),
    ...(e.rule === undefined ? {} : { rule: e.rule }),
    message: e.message,
  };
}

/** Cap raw gate output to its last {@link MAX_OUTPUT_CHARS} chars — the TAIL, where
 *  a crash's actionable error usually sits — and disclose the cut (`outputTruncated`
 *  + `outputOmittedChars`) so a cut-off log never reads as the whole failure
 *  (no-silent-truncation house rule). Under the cap ⇒ just `{output}`. */
function capOutput(output: string): {
  output: string;
  outputTruncated?: true;
  outputOmittedChars?: number;
} {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return { output };
  }

  return {
    output: output.slice(output.length - MAX_OUTPUT_CHARS),
    outputTruncated: true,
    outputOmittedChars: output.length - MAX_OUTPUT_CHARS,
  };
}

/** Drop duplicate diagnostics by their stable `key` (same file/line/rule), keeping
 *  first-seen order — repeated `check` calls and dual-format gate output stay clean. */
function dedupe(errors: readonly IErrorItem[]): IErrorItem[] {
  const seen = new Set<string>();
  const out: IErrorItem[] = [];

  for (const e of errors) {
    if (!seen.has(e.key)) {
      seen.add(e.key);
      out.push(e);
    }
  }

  return out;
}

/**
 * The `check` tool: run the fast acceptance gate NOW and hand the model its whole
 * STRUCTURED error set (`{file,line,rule,message}`) mid-turn — so it fixes every
 * error in one pass instead of discovering them one-per-turn (the model's own #1
 * ask; a primary driver of near-green turn-waste). The gate runner is injected
 * (`ctx.runCheck`) so the core tool stays stack-agnostic; absent ⇒ it says so
 * rather than pretending. Returns compact JSON the model can act on directly.
 */
export async function doCheck(
  _args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  if (ctx.runCheck === undefined) {
    return (
      "check is not available in this session (no gate is wired here). Stop " +
      "calling tools and the gate will run automatically."
    );
  }

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: "check: running the gate",
  });

  const result = await ctx.runCheck();

  // Files the gate's autofix reformatted/rewrote this run — the model must re-read
  // them before editing again (their on-disk content + anchors changed). Surfaced
  // on BOTH pass and fail, mirroring settleGate's autofix notice.
  const autoFixed =
    result.autoFixed.length > 0 ? { autoFixed: result.autoFixed } : {};

  if (result.passed) {
    return JSON.stringify({ passed: true, errors: [], ...autoFixed });
  }

  const deduped = dedupe(result.errors);
  const shown = deduped.slice(0, MAX_ERRORS).map(toStruct);
  const omitted = deduped.length - shown.length;

  // A gate can fail with NO parseable errors (a command crashed in an unrecognized
  // format). Empty `errors` would leave the model blind, so surface the raw output
  // as the only diagnostic it has — keeping the TAIL (a crash's actionable error is
  // usually last) and DISCLOSING the cut, per the no-silent-truncation house rule.
  const rawOutput =
    deduped.length === 0 && result.output.trim().length > 0
      ? capOutput(result.output)
      : {};

  return JSON.stringify({
    passed: false,
    errorCount: deduped.length,
    ...(omitted > 0 ? { omitted } : {}),
    errors: shown,
    ...rawOutput,
    ...autoFixed,
  });
}
