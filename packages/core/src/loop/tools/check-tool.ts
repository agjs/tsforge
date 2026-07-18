import type { IToolContext } from "./tool-context";
import type { IErrorItem } from "../../validate/validate.types";

/** Cap the error list so a huge failure set can't blow the turn's context budget. */
const MAX_ERRORS = 200;

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

  if (result.passed) {
    return JSON.stringify({ passed: true, errors: [] });
  }

  const deduped = dedupe(result.errors);
  const shown = deduped.slice(0, MAX_ERRORS).map(toStruct);
  const omitted = deduped.length - shown.length;

  return JSON.stringify({
    passed: false,
    errorCount: deduped.length,
    ...(omitted > 0 ? { omitted } : {}),
    errors: shown,
  });
}
