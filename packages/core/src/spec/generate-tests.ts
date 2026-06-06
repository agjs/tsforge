import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { IChatMessage, IProvider } from "../inference/types";
import type { Reporter } from "../loop/events";
import { CREATE_TOOL, TOOL_NAME, toCreate } from "../agent/tools";
import { applyCreate } from "../files/create";
import { isInScope } from "../lib/scope";
import {
  runTests,
  isRealRed,
  type IRunTestsResult,
} from "../validate/run-tests";

export interface IGenerateTestsOptions {
  /** Where to write the suite. */
  testFile: string;
  /** Where to write the throwing stub the suite runs against (the future impl). */
  implFile: string;
  /** One-line statement of what's under test (e.g. the spec title). */
  goal: string;
  /** The acceptance criteria prose the tests must encode. */
  criteria: string;
  /** Max model turns (default 6). The suite + stub usually land over 1-2 turns. */
  maxAttempts?: number;
  onEvent?: Reporter;
}

export interface IGenerateTestsResult {
  testFile: string;
  /** True once the suite loads, collects tests, and is RED against the stub. */
  ok: boolean;
  testCount: number;
  attempts: number;
}

/**
 * Turn a spec's acceptance criteria into an executable `bun:test` suite — the
 * step that lets an *untested* spec enter the deterministic gate.
 *
 * The model writes the suite plus a throwing stub of the impl (over one or more
 * turns), so the suite is runnable (imports resolve) yet starts RED. `runTests`
 * is the oracle, and a suite is accepted only when it: (1) loads cleanly (no errors),
 * (2) collects >= 1 test, and (3) is fully RED — every test fails against the
 * do-nothing stub. (3) is the load-bearing check: a vacuous test that never
 * calls the implementation would PASS against the stub, and we reject exactly
 * those. The result is the precise RED seed the implement loop then drives green.
 */
export async function generateTests(
  provider: IProvider,
  cwd: string,
  opts: IGenerateTestsOptions
): Promise<IGenerateTestsResult> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const report: Reporter = opts.onEvent ?? (() => undefined);
  const scope = [opts.testFile, opts.implFile];

  let attempts = 0;
  let feedback = "";

  while (attempts < maxAttempts) {
    attempts += 1;

    // Re-prompt with the CURRENT file state each turn rather than wiping
    // progress: tool-calling models emit roughly one `create` per turn, so the
    // suite lands one turn and the stub the next. The prompt names which files
    // are still missing; `create` upserts so a bad file can be overwritten.
    const present = await whichExist(cwd, [opts.testFile, opts.implFile]);
    const res = await provider.complete(buildPrompt(opts, present, feedback), {
      tools: [CREATE_TOOL],
      temperature: 0,
      onToken: (text) => {
        report({ kind: "token", task: opts.testFile, message: text });
      },
    });

    for (const call of res.toolCalls) {
      await applyCreateCall(scope, cwd, call.name, call.arguments, report);
    }

    const run = await runTests(opts.testFile, cwd);
    const verdict = assess(run);

    report({
      kind: "fix",
      task: opts.testFile,
      message: `turn ${attempts}: ${run.total} tests, ${run.pass} pass, ${run.fail} fail, ${run.errors} err — ${verdict.ok ? "accepted (RED)" : verdict.reason}`,
    });

    if (verdict.ok) {
      return {
        testFile: opts.testFile,
        ok: true,
        testCount: run.total,
        attempts,
      };
    }

    feedback = `${verdict.reason}\nRunner output:\n${run.output}`;
  }

  return { testFile: opts.testFile, ok: false, testCount: 0, attempts };
}

/** Which of `files` currently exist in `cwd` (for telling the model what's left). */
async function whichExist(cwd: string, files: string[]): Promise<Set<string>> {
  const present = new Set<string>();

  for (const file of files) {
    if (await Bun.file(join(cwd, file)).exists()) {
      present.add(file);
    }
  }

  return present;
}

interface IVerdict {
  ok: boolean;
  reason: string;
}

/** The deterministic "are these real tests?" oracle. */
function assess(run: IRunTestsResult): IVerdict {
  if (run.errors > 0) {
    return { ok: false, reason: "the suite failed to load/parse" };
  }

  if (run.total === 0) {
    return { ok: false, reason: "no tests were collected" };
  }

  if (run.pass > 0) {
    return {
      ok: false,
      reason: `${run.pass} test(s) passed against a stub that throws on every call — those tests don't exercise the implementation`,
    };
  }

  return { ok: isRealRed(run), reason: "" };
}

async function applyCreateCall(
  scope: string[],
  cwd: string,
  name: string,
  args: Record<string, unknown>,
  report: Reporter
): Promise<void> {
  if (name !== TOOL_NAME.create) {
    return;
  }

  const create = toCreate(args);

  if (create === null || !isInScope(create.file, scope)) {
    return;
  }

  // Upsert: generateTests is the authority for these two scoped files, so a
  // `create` re-writes (drop any prior, then create) rather than no-clobbering —
  // the model regenerates a whole file to fix it.
  await rm(join(cwd, create.file), { force: true });

  const result = await applyCreate(cwd, create);

  if (result.ok) {
    report({
      kind: "create",
      task: create.file,
      file: create.file,
      message: `create ${create.file}`,
      content: create.content,
    });
  }
}

function buildPrompt(
  opts: IGenerateTestsOptions,
  present: Set<string>,
  feedback: string
): IChatMessage[] {
  const moduleSpecifier = `./${opts.implFile.replace(/\.ts$/, "")}`;

  const system = [
    "You are a TypeScript test author. From acceptance criteria you write a rigorous, executable `bun:test` suite that pins behaviour with concrete, literal expected values.",
    "Cover the happy path AND the edge cases the criteria imply (zero, negative, empty, boundary, rounding, large values). Every acceptance item maps to at least one assertion, and EVERY test must call the implementation under test.",
    `You must produce TWO files via \`create\` calls (emit as many per turn as you can):\n  1. The test file — \`import { test, expect } from "bun:test";\` and import the implementation from "${moduleSpecifier}".\n  2. The implementation stub — export every function the tests import, with the correct signature but a body that does \`throw new Error("not implemented")\`.`,
    "The stub makes the suite runnable and guarantees it starts RED: if any test passes against a stub that throws on every call, that test isn't really testing the implementation — don't write tests like that.",
    "A `create` overwrites the file if it already exists, so to fix a file just create it again with the corrected full contents.",
    "House rules: no `any`, no `as`, no non-null `!`; prefer `const`.",
  ].join("\n");

  const missing = [opts.testFile, opts.implFile].filter((f) => !present.has(f));
  const state =
    missing.length > 0
      ? `Files still MISSING — create them now: ${missing.join(", ")}.`
      : "Both files exist; fix whichever the runner rejected by re-creating it.";

  const retry =
    feedback.length > 0 ? `The current state was rejected: ${feedback}` : "";

  const user = [
    `Write the test suite at: ${opts.testFile}`,
    `Write the implementation stub at: ${opts.implFile}`,
    `Goal: ${opts.goal}`,
    `Acceptance criteria:\n${opts.criteria}`,
    state,
    retry,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
