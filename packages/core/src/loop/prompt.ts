import type { ITask } from "../spec";
import type { IFileView } from "../lib/fs";
import { renderFileSection } from "./project-map";

/** The implement-agent system prompt: who it is, the tools, and the strict-TS
 *  house rules the gate enforces. */
export const SYSTEM = [
  "You are an expert TypeScript engineer working inside tsforge, a harness specialized for STRICT TypeScript. Implement the task by editing code until the gate passes.",
  "Tools: `read` (inspect a file), `edit` (replace an exact, unique snippet), `create` (a new file), `run` (execute any shell command and see its output).",
  "Lead with action: write the implementation FIRST (one `create`/`edit`) — do NOT deliberate at length before writing any code.",
  "After every edit the harness AUTOMATICALLY runs the gate and gives you the result (the errors + fix guidance for the failing rules). You do NOT need to run the acceptance command yourself — read that result and fix exactly what it reports, then edit again. Keep going until it reports green; the harness ends the task at that point.",
  "Test hypotheses by RUNNING them, never by reasoning them out. Unsure about an edge case, rounding, or ordering (`Math.floor(100/3)`, largest-remainder ties)? `run` a quick `bun -e '…console.log(…)'`, or write a throwaway `scratch/check.ts` importing your impl and `run` it. `scratch/` is yours — the gate ignores it.",
  "The gate is `tsc` strict + eslint with every rule an error, so write TypeScript that satisfies it: interfaces are `I`-prefixed; `===`; no `var`; never the non-null `!` — guard index access (`const x = arr[i]; if (x === undefined) {...}`); no `any` and no `as` — type every parameter (e.g. `.reduce((acc: number, r: number) => …, 0)`); explicit boolean conditions. When the gate flags errors in read-only files (tests/types), they come from your editable file being missing or wrong-shaped and vanish once it's correct — don't edit them.",
].join("\n");

/** Build the first user message: the task contract + editable/context files
 *  (full dumps when small, a navigable MAP when large — see renderFileSection). */
export function seedPrompt(
  task: ITask,
  editable: IFileView[],
  context: IFileView[]
): string {
  const intent =
    task.intent !== undefined && task.intent.length > 0
      ? `Spec contract — implement EXACTLY this:\n${task.intent}`
      : "";

  const ed = renderFileSection(editable);
  const editableText =
    editable.length === 0
      ? "(none of the editable files exist yet — create them)"
      : ed.mapped
        ? `The editable files are large — here is a MAP (path · lines · exports). INSPECT specifics with read/search/symbol_search/find_references before editing; don't guess:\n${ed.text}`
        : ed.text;

  const ctx = context.length > 0 ? renderFileSection(context) : null;
  const contextText =
    ctx === null
      ? ""
      : `Read-only context (do NOT edit)${ctx.mapped ? " — MAP; read specifics on demand" : ""}:\n${ctx.text}`;

  return [
    `Task ${task.id}.`,
    intent,
    `Acceptance command (run this to verify — it must exit 0): ${task.accept}`,
    `Editable files: ${task.files.join(", ")}`,
    `Current editable contents:\n${editableText}`,
    contextText,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}
