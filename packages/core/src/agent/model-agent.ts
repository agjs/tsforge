import { basename } from "node:path";
import type { IAgent, IAgentContext } from "./agent.types";
import type { IChatMessage, IProvider } from "../inference";
import type { ErrorSet } from "../validate";
import { applyEdits } from "../files/edit";
import { applyCreate } from "../files/create";
import { EDIT_FAIL_REASON } from "../files";
import { isInScope, normalizeWorkspacePath } from "../lib/scope";
import { readFiles, type IFileView } from "../lib/fs";
import { EDIT_TOOL, CREATE_TOOL, TOOL_NAME } from "./agent.constants";
import { toEdits, toCreate } from "./tools";
import { ruleHelp } from "../loop/feedback";
import { DEFAULT_TEMPERATURE } from "../loop/loop.constants";
import { summarizeGateCommand } from "../loop/gate-visibility";

/**
 * The errors the agent can actually act on: those in its editable files (plus
 * file-less generic ones). Cascade errors located in read-only context (e.g. a
 * test file failing because the not-yet-created impl can't be imported) are NOT
 * the model's to fix — surfacing them makes it spiral on a contradiction it
 * can't resolve. Those clear on their own once the editable files are correct.
 */
function editableErrors(errors: ErrorSet, files: string[]): ErrorSet {
  return errors.filter((e) => {
    if (e.file === undefined) {
      return true;
    }

    return isInScope(e.file, files) || isInScope(basename(e.file), files);
  });
}

/**
 * The real agent: show the model the declared files + current failures, ask for
 * `edit`/`create` tool calls, and apply them through the edit engine (which
 * enforces exact/unique matches and no-clobber creates). The model can only
 * produce a matching `oldString` if it sees the file, so we read the declared
 * files into context first.
 */
export function modelAgent(
  provider: IProvider,
  options: { temperature?: number; thinkingTokenBudget?: number } = {}
): IAgent {
  // Edit-application failures from the previous cycle, fed back so the model
  // learns when an edit was rejected (otherwise rejections are invisible to it).
  let lastFailures: string[] = [];

  return {
    async implement(ctx: IAgentContext): Promise<void> {
      const editable = await readFiles(ctx.cwd, ctx.task.files);
      const readonly = await readFiles(ctx.cwd, ctx.task.context ?? []);
      const res = await provider.complete(
        buildMessages(ctx, editable, readonly, lastFailures),
        {
          tools: [EDIT_TOOL, CREATE_TOOL],
          toolChoice: "auto",
          // Temp 0 by default — the eval sweep showed it's decisively better for
          // convergence on coding tasks (temp 0: 100% pass vs temp 0.5: 0%).
          temperature: options.temperature ?? DEFAULT_TEMPERATURE,
          // Cap reasoning so the quality-repair pass can't ramble unbounded
          // ("writing novels"): the budget that bounds the implement loop must
          // bound this agent too, or the cap leaks.
          ...(options.thinkingTokenBudget === undefined
            ? {}
            : { thinkingTokenBudget: options.thinkingTokenBudget }),
          // Stream: keeps the connection alive on long thinking calls (no
          // idle-drop) and emits a heartbeat. Reasoning is NOT logged — only a
          // dim dot per ~200 reasoning chars (proof of life, not the wall).
          onToken: (text) => {
            ctx.report?.({ kind: "token", task: ctx.task.id, message: text });
          },
        }
      );

      const failures: string[] = [];

      for (const call of res.toolCalls) {
        const failure = await applyCall(ctx, call.name, call.arguments);

        if (failure !== null) {
          failures.push(failure);
        }
      }

      lastFailures = failures;
    },
  };
}

/** Apply one tool call; return a human-readable failure message, or null on success. */
async function applyCall(
  ctx: IAgentContext,
  name: string,
  args: Record<string, unknown>
): Promise<string | null> {
  if (name === TOOL_NAME.edit) {
    return applyAgentEdit(ctx, args);
  }

  if (name === TOOL_NAME.create) {
    return applyAgentCreate(ctx, args);
  }

  return null;
}

async function applyAgentEdit(
  ctx: IAgentContext,
  args: Record<string, unknown>
): Promise<string | null> {
  const edit = toEdits(args);

  if (edit === null) {
    return "an `edit` call had malformed arguments (need `file` plus `oldString`/`newString` or an `edits` array)";
  }

  edit.file = normalizeWorkspacePath(ctx.cwd, edit.file);

  const scopeError = outOfScope(ctx, edit.file);

  if (scopeError !== null) {
    return scopeError;
  }

  const result = await applyEdits(ctx.cwd, edit.file, edit.edits);

  if (result.ok) {
    // Skip the mutation event for a no-op edit (same content) so it isn't counted.
    if (result.changed) {
      for (const r of edit.edits) {
        ctx.report?.({
          kind: "edit",
          task: ctx.task.id,
          file: edit.file,
          message: `edit ${edit.file}`,
          oldString: r.oldString,
          newString: r.newString,
        });
      }
    }

    return null;
  }

  const where =
    edit.edits.length > 1 ? ` (replacement #${result.index + 1})` : "";
  const detail =
    result.reason === EDIT_FAIL_REASON.ambiguous
      ? `oldString matched ${result.matches ?? 0} places — include more surrounding lines to make it unique`
      : result.reason;

  ctx.report?.({
    kind: "edit",
    task: ctx.task.id,
    file: edit.file,
    message: `${edit.file} — rejected (${result.reason})`,
  });

  return `edit to ${edit.file} REJECTED${where}: ${detail}`;
}

async function applyAgentCreate(
  ctx: IAgentContext,
  args: Record<string, unknown>
): Promise<string | null> {
  const create = toCreate(args);

  if (create === null) {
    return "a `create` call had malformed arguments (need file, content)";
  }

  create.file = normalizeWorkspacePath(ctx.cwd, create.file);

  const scopeError = outOfScope(ctx, create.file);

  if (scopeError !== null) {
    return scopeError;
  }

  const result = await applyCreate(ctx.cwd, create);

  if (result.ok) {
    ctx.report?.({
      kind: "create",
      task: ctx.task.id,
      file: create.file,
      message: `create ${create.file}`,
      content: create.content,
    });

    return null;
  }

  ctx.report?.({
    kind: "create",
    task: ctx.task.id,
    file: create.file,
    message: `${create.file} — rejected (already exists)`,
  });

  return `create ${create.file} REJECTED: file already exists — use \`edit\` instead`;
}

/** Reject (and report) an edit/create whose path is outside the editable scope. */
function outOfScope(ctx: IAgentContext, file: string): string | null {
  if (isInScope(file, ctx.task.files)) {
    return null;
  }

  ctx.report?.({
    kind: "edit",
    task: ctx.task.id,
    file,
    message: `${file} — out of scope (read-only)`,
  });

  return `${file} is OUT OF SCOPE — you may only edit/create: ${ctx.task.files.join(
    ", "
  )}. Read-only context (tests, etc.) must not be changed.`;
}

function buildMessages(
  ctx: IAgentContext,
  editable: IFileView[],
  readonly: IFileView[],
  priorFailures: string[]
): IChatMessage[] {
  const system = [
    "You are a TypeScript engineer working inside an automated harness. Make the task pass by emitting `edit` and `create` tool calls.",
    "`edit` replaces an exact, UNIQUE snippet in an existing file — include enough surrounding lines so oldString matches exactly once. `create` makes a new file.",
    "Scope: you may ONLY edit/create the editable files. NEVER edit the read-only context (tests, specs) — it is fixed.",
    "House rules (enforced by the gate): interfaces are `I`-prefixed and you update EVERY reference when you rename a type; never use the non-null assertion `!` — guard index access instead (`const x = arr[i]; if (x !== undefined)`); avoid `while (true)` and other constant conditions — prefer `.filter(...)`, `for...of`, or a bounded loop; no `any` and no `as`; change only what the failures require and don't re-break fixed issues.",
  ].join("\n");

  const editableText =
    editable.length > 0
      ? editable.map((f) => `File ${f.path}:\n${f.content}`).join("\n\n")
      : "(no editable files exist yet — create them)";

  const contextText =
    readonly.length > 0
      ? `Read-only context (do NOT edit):\n${readonly
          .map((f) => `File ${f.path}:\n${f.content}`)
          .join("\n\n")}`
      : "";

  // Only show failures the model can actually fix (in its editable files).
  const ownErrors = editableErrors(ctx.errors, ctx.task.files);
  const readOnlyCount = ctx.errors.length - ownErrors.length;

  const failures =
    ownErrors.length > 0
      ? `Current failures in your editable files:\n${ownErrors
          .map((e) => `- ${e.message}`)
          .join("\n")}`
      : "No failures in your editable files.";

  const readOnlyNote =
    readOnlyCount > 0
      ? `Note: ${readOnlyCount} other gate error(s) are in READ-ONLY files (e.g. tests). They are NOT yours to fix and will resolve once your editable files export the right shapes — ignore them.`
      : "";

  // The failing rules' own docs (bad→good), keyed to the model's OWN errors —
  // so it fixes from the rule's example instead of re-deriving it.
  const coaching = ruleHelp(ownErrors);
  const guidance =
    coaching.length > 0
      ? `How to satisfy the gate here (the failing rules, with examples):\n${coaching}`
      : "";

  const rejected =
    priorFailures.length > 0
      ? `Your previous edits were REJECTED and did NOT apply — fix and retry:\n${priorFailures
          .map((f) => `- ${f}`)
          .join("\n")}`
      : "";

  const intent =
    ctx.task.intent !== undefined && ctx.task.intent.length > 0
      ? `Spec contract — implement EXACTLY this (authoritative; the tests check it but this states the intent):\n${ctx.task.intent}`
      : "";

  const user = [
    `Task ${ctx.task.id} (cycle ${ctx.cycle}).`,
    intent,
    `Acceptance command: ${summarizeGateCommand(ctx.task.accept)}`,
    `Editable files: ${ctx.task.files.join(", ")}`,
    `Editable file contents:\n${editableText}`,
    contextText,
    failures,
    readOnlyNote,
    guidance,
    rejected,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
