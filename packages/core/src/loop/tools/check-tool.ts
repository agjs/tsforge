import type { IToolContext } from "./tool-context";
import type { IErrorItem } from "../../validate/validate.types";

/** Cap the error list so a huge failure set can't blow the turn's context budget. */
const MAX_ERRORS = 200;

/** Raw-output cap when the gate failed but parsed NO structured errors — the output
 *  IS the only diagnostic, so keep a big tail. */
const MAX_OUTPUT_CHARS = 4000;

/** Raw-output cap when structured errors ARE present — the errors are the distilled
 *  signal; a short tail only needs to catch a trailing unparsed crash without
 *  re-dumping the whole gate log (which extract-failures already condensed). */
const MAX_OUTPUT_WITH_ERRORS = 600;

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

/** Cap raw gate output to its last `max` chars — the TAIL, where a crash's actionable
 *  error usually sits — and disclose the cut (`outputTruncated` + `outputOmittedChars`)
 *  so a cut-off log never reads as the whole failure (no-silent-truncation house rule).
 *  Under the cap ⇒ just `{output}`. */
function capOutput(
  output: string,
  max: number
): {
  output: string;
  outputTruncated?: true;
  outputOmittedChars?: number;
} {
  if (output.length <= max) {
    return { output };
  }

  return {
    output: output.slice(output.length - max),
    outputTruncated: true,
    outputOmittedChars: output.length - max,
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
 *
 * ORDERING: check runs the gate's autofix (mutates on-disk source), so its result is
 * only authoritative if no edit runs concurrently. It relies on `runToolCalls`, which
 * executes every non-`spawn_agent` tool SEQUENTIALLY as an ordering barrier — an
 * `edit` and a `check` in one model response never overlap. If that executor ever
 * parallelizes non-spawn tools, check would need its own serialization.
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

  // Surface the raw gate output on EVERY failure — not only when zero errors parsed.
  // A partial parse (some lint errors PLUS an unrecognized crash line) would otherwise
  // hide the crash while the response looks complete. Big tail when errors are empty
  // (output is the ONLY signal); short tail when errors are present (they're the
  // distilled signal — just catch a trailing crash). Always DISCLOSE any cut.
  const rawOutput =
    result.output.trim().length > 0
      ? capOutput(
          result.output,
          deduped.length === 0 ? MAX_OUTPUT_CHARS : MAX_OUTPUT_WITH_ERRORS
        )
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
