import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILoopCtx } from "../src/loop/turn";
import { polishOnGreen } from "../src/loop/turn";
import type { IValidateResult } from "../src/validate";

/** A file with a droppable annotation (`const abs: number = Math.abs(...)` — the exact
 *  shape dropRedundantAnnotations removes). Dropping it is the "polish". */
const SOURCE = "const cents = 1;\nconst abs: number = Math.abs(cents);\n";

/** Build a minimal ILoopCtx whose INJECTED gate returns `gatePassed`, with an EMPTY
 *  `task.accept` — the boringstack shape (it drives an injected gate, not `accept`). */
function ctxWith(
  cwd: string,
  gatePassed: boolean
): { ctx: ILoopCtx; calls: { runCalls: number } } {
  const box = { runCalls: 0 };
  const ctx: ILoopCtx = {
    task: { id: "t", intent: "test", accept: "", files: ["a.ts"], context: [] },
    cwd,
    tsService: null,
    report: () => undefined,
    messages: [],
    // polishOnGreen now scopes the drop to the files the model wrote (ctx.tool.touched),
    // not task.files — so the tests must mark a.ts as touched for the drop to run.
    tool: { touched: new Set(["a.ts"]) },
    gate: {
      parse: undefined,
      runner: {
        run: async (): Promise<IValidateResult> => {
          box.runCalls += 1;

          return { passed: gatePassed, errors: [], output: "" };
        },
      },
    },
  };

  return { ctx, calls: box };
}

test("polishOnGreen REVERTS the drop when the INJECTED gate regresses (empty task.accept)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-polish-"));

  try {
    await Bun.write(join(dir, "a.ts"), SOURCE);

    // The injected gate reports RED after the drop (the drop removed a load-bearing
    // annotation). With the OLD code — validate(task.accept="") — this recheck passed
    // vacuously and the broken drop shipped; the injected gate must drive the revert.
    const { ctx, calls } = ctxWith(dir, false);

    await polishOnGreen(ctx);

    // The INJECTED gate was actually invoked for the recheck (not a vacuous pass).
    expect(calls.runCalls).toBeGreaterThan(0);
    // Rolled back: the annotation is restored (the drop did NOT ship).
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(SOURCE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("polishOnGreen REVERTS the drop when the injected gate THROWS (transient judge failure)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-polish-"));

  try {
    await Bun.write(join(dir, "a.ts"), SOURCE);

    // The composed gate's judge model call can throw transiently. A throw must not leave
    // the unverified drop on disk, nor crash — it must roll back to the pre-polish state.
    const ctx: ILoopCtx = {
      task: {
        id: "t",
        intent: "test",
        accept: "",
        files: ["a.ts"],
        context: [],
      },
      cwd: dir,
      tsService: null,
      report: () => undefined,
      messages: [],
      tool: { touched: new Set(["a.ts"]) },
      gate: {
        parse: undefined,
        runner: {
          run: async (): Promise<IValidateResult> => {
            throw new Error("judge provider timed out");
          },
        },
      },
    };

    await polishOnGreen(ctx); // must not throw

    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(SOURCE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("polishOnGreen re-throws on caller cancellation (honors the signal) but still reverts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-polish-"));

  try {
    await Bun.write(join(dir, "a.ts"), SOURCE);

    const controller = new AbortController();

    controller.abort();

    const ctx: ILoopCtx = {
      task: {
        id: "t",
        intent: "test",
        accept: "",
        files: ["a.ts"],
        context: [],
      },
      cwd: dir,
      tsService: null,
      report: () => undefined,
      messages: [],
      tool: { signal: controller.signal, touched: new Set(["a.ts"]) },
      gate: {
        parse: undefined,
        runner: {
          run: async (): Promise<IValidateResult> => {
            throw new Error("aborted");
          },
        },
      },
    };

    // A cancellation must NOT be swallowed as a transient failure — it re-throws…
    let threw = false;

    try {
      await polishOnGreen(ctx);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    // …but the tree is still restored to the pre-polish green state first.
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(SOURCE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("polishOnGreen wraps a NON-Error abort rejection in an Error (typed re-throw)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-polish-"));

  try {
    await Bun.write(join(dir, "a.ts"), SOURCE);

    const controller = new AbortController();

    controller.abort();

    const ctx: ILoopCtx = {
      task: {
        id: "t",
        intent: "test",
        accept: "",
        files: ["a.ts"],
        context: [],
      },
      cwd: dir,
      tsService: null,
      report: () => undefined,
      messages: [],
      tool: { signal: controller.signal, touched: new Set(["a.ts"]) },
      gate: {
        parse: undefined,
        runner: {
          // A rejection that is NOT an Error (some providers reject with a
          // string/object). Typed `unknown` so it is a rejection reason, not a
          // literal throw. The typed-throw branch must wrap it in an Error so
          // only-throw-error holds and the caller gets a real Error.
          run: async (): Promise<IValidateResult> => {
            const reason: unknown = "aborted-string";

            throw reason;
          },
        },
      },
    };

    let caught: unknown = null;

    try {
      await polishOnGreen(ctx);
    } catch (err) {
      caught = err;
    }

    // Re-thrown as a real Error (not the raw string) with the abort message…
    expect(caught).toBeInstanceOf(Error);

    if (caught instanceof Error) {
      expect(caught.message).toContain("aborted by caller signal");
    }

    // …and the tree is still restored first.
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(SOURCE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("polishOnGreen KEEPS the drop when the injected gate stays green", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-polish-"));

  try {
    await Bun.write(join(dir, "a.ts"), SOURCE);

    const { ctx } = ctxWith(dir, true);

    await polishOnGreen(ctx);

    // The redundant `: number` was dropped and (gate green) kept.
    const out = await Bun.file(join(dir, "a.ts")).text();

    expect(out).toContain("const abs = Math.abs(cents)");
    expect(out).not.toContain(": number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// #103 (panel-critical): polish drops+formats ONLY files the model wrote. With a
// whole-repo scope (the REPL default ["**/*"]) and only a.ts touched, an untouched
// sibling that has its own droppable annotation must be left byte-identical. A
// regression back to resolveScopeFiles(task.files) would drop/rewrite the sibling and
// fail here — the narrow-scope tests above would NOT catch that.
test("polishOnGreen with whole-repo scope drops ONLY the touched file, not siblings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-polish-"));

  try {
    const droppable = "const abs: number = Math.abs(1);\n";

    await Bun.write(join(dir, "a.ts"), droppable);
    await Bun.write(join(dir, "sibling.ts"), droppable);

    const { ctx: base } = ctxWith(dir, true);
    const ctx: ILoopCtx = {
      ...base,
      // Whole-repo scope, but only a.ts was written by the model.
      task: { ...base.task, files: ["**/*"] },
      tool: { touched: new Set(["a.ts"]) },
    };

    await polishOnGreen(ctx);

    // a.ts polished (annotation dropped)…
    expect(await Bun.file(join(dir, "a.ts")).text()).not.toContain(": number");
    // …sibling.ts left exactly as it was (never touched by the model).
    expect(await Bun.file(join(dir, "sibling.ts")).text()).toBe(droppable);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// When a spec-provided task.fix is set, the revert snapshot must ALSO cover the resolved
// scope (task.fix is an arbitrary command that can edit an in-scope sibling outside
// touched). On a failed re-gate, that sibling mutation must roll back too. A regression to
// snapshotting only touched would leave the fix's damage on disk.
test("polishOnGreen rolls back a task.fix mutation to a NON-touched sibling on a failed re-gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-polish-"));

  try {
    const originalSibling = "const sibling = 1;\n";

    await Bun.write(join(dir, "a.ts"), SOURCE); // touched + droppable → polish proceeds
    await Bun.write(join(dir, "sibling.ts"), originalSibling);

    const { ctx: base } = ctxWith(dir, false); // gate RED → recheck fails → revert
    const ctx: ILoopCtx = {
      ...base,
      task: {
        ...base.task,
        files: ["**/*"],
        // The fix mutates a sibling the model never wrote (not in touched).
        fix: "printf 'const sibling = 999;\\n' > sibling.ts",
      },
      tool: { touched: new Set(["a.ts"]) },
    };

    await polishOnGreen(ctx);

    // The failed re-gate rolled EVERYTHING back — including the fix's sibling mutation.
    expect(await Bun.file(join(dir, "sibling.ts")).text()).toBe(
      originalSibling
    );
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(SOURCE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("polishOnGreen with coreFormat on formats the TOUCHED file after the drop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-polish-"));

  try {
    // Messy AND has a droppable `: number` annotation, so polish proceeds past the
    // drop guard; the scoped format janitor should then clean the messiness.
    await Bun.write(
      join(dir, "a.ts"),
      "const  cents=1;\nconst abs: number = Math.abs(cents);\n"
    );

    const { ctx: base } = ctxWith(dir, true);
    const ctx: ILoopCtx = {
      ...base,
      // The model wrote a.ts, so it is the janitor's target (NOT task.files scope).
      tool: { touched: new Set(["a.ts"]) },
      gate: { ...base.gate, coreFormat: true },
    };

    await polishOnGreen(ctx);

    const out = await Bun.file(join(dir, "a.ts")).text();

    // Dropped (`: number` gone) AND formatted (`const  cents=1` → `const cents = 1;`).
    expect(out).not.toContain(": number");
    expect(out).toContain("const cents = 1;");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
