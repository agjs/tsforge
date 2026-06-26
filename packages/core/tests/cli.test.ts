import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  isOneShot,
  applyRecipe,
  runNotify,
  createPasteBatcher,
} from "../src/cli";
import type { ITaskRecipe } from "../src/config/recipes";

// Regression: runNotify used to spawn `sh -c cmd` with a bare `await proc.exited`
// — no timeout. A hanging notifier (curl to a dead host, a stray `read`) wedged
// the run forever at the finish line of an unattended/cron build. It now routes
// through the shared runner with NOTIFY_TIMEOUT_MS, so it ALWAYS returns.
test("runNotify is bounded — a hanging notifier cannot wedge the run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-notify-"));

  try {
    const start = Bun.nanoseconds();

    // `sleep 30` stands in for a foreground-hanging notifier. With the override
    // timeout (300ms) the runner kills it; the old unbounded `await proc.exited`
    // would block the full 30s. Asserting a sub-5s return is impossible without
    // the kill-timeout the shared runner provides.
    await runNotify(dir, "sleep 30", "done 3/3", 300);
    const elapsedMs = (Bun.nanoseconds() - start) / 1e6;

    expect(elapsedMs).toBeLessThan(5000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parses task + files + accept + dir", () => {
  const a = parseArgs([
    "add",
    "a",
    "clear",
    "button",
    "--files",
    "App.tsx, B.tsx",
    "--accept",
    "bun test App.test.tsx",
    "--dir",
    "/proj",
  ]);

  expect(a.task).toBe("add a clear button");
  expect(a.files).toEqual(["App.tsx", "B.tsx"]);
  expect(a.accept).toBe("bun test App.test.tsx");
  expect(a.dir).toBe("/proj");
  expect(isOneShot(a)).toBe(true);
});

test("isOneShot is false unless task + files + gate are all present", () => {
  // These now parse fine (interactive mode); they just aren't one-shot.
  expect(isOneShot(parseArgs(["do a thing"]))).toBe(false); // no --files/--accept
  expect(isOneShot(parseArgs(["--files", "a.ts", "--accept", "x"]))).toBe(
    false
  ); // no task
  expect(isOneShot(parseArgs(["task", "--files", "a.ts"]))).toBe(false); // no --accept
});

test("bare invocation parses to an empty interactive session", () => {
  const a = parseArgs([]);

  expect(a.task).toBe("");
  expect(a.files).toEqual([]);
  expect(a.accept).toBe("");
  expect(isOneShot(a)).toBe(false);
});

test("`tsforge run <id>` parses the recipe id and trailing task", () => {
  const a = parseArgs(["run", "api-endpoint", "add", "a", "route"]);

  expect(a.run).toBe(true);
  expect(a.recipe).toBe("api-endpoint");
  expect(a.task).toBe("add a route");
});

test("`tsforge run` with no id flags the run subcommand (so main can error)", () => {
  const a = parseArgs(["run"]);

  expect(a.run).toBe(true);
  expect(a.recipe).toBe("");
});

test("`tsforge setup` flags the setup subcommand; --yes sets setupYes", () => {
  const a = parseArgs(["setup"]);

  expect(a.setup).toBe(true);
  expect(a.setupYes).toBe(false);

  const b = parseArgs(["setup", "--yes"]);

  expect(b.setup).toBe(true);
  expect(b.setupYes).toBe(true);
});

test("`tsforge recipes` and `--recipe <id>` are recognized", () => {
  expect(parseArgs(["recipes"]).recipes).toBe(true);
  expect(parseArgs(["--recipe", "web-build", "build it"]).recipe).toBe(
    "web-build"
  );
});

test("--scout parses, and a recipe can turn scout on", () => {
  expect(parseArgs(["fix it", "--scout"]).scout).toBe(true);
  expect(parseArgs(["fix it"]).scout).toBe(false);

  const args = parseArgs(["fix it"]);

  applyRecipe(args, { id: "brownfield", scout: true });
  expect(args.scout).toBe(true);
});

test("--greenfield parses, and a recipe with mode:greenfield turns it on + routes role models", () => {
  expect(parseArgs(["build an app", "--greenfield"]).greenfield).toBe(true);
  expect(parseArgs(["build an app"]).greenfield).toBe(false);

  const args = parseArgs(["build a kanban app"]);

  applyRecipe(args, {
    id: "kanban",
    mode: "greenfield",
    gate: "bun run build",
    plannerModel: "planner",
    workModel: "coder",
    evaluatorModel: "judge",
  });

  expect(args.greenfield).toBe(true);
  expect(args.accept).toBe("bun run build");
  expect(args.plannerModel).toBe("planner");
  expect(args.workModel).toBe("coder");
  expect(args.evaluatorModel).toBe("judge");
});

test("applyRecipe fills defaults but an explicit CLI value always wins", () => {
  const recipe: ITaskRecipe = {
    id: "api-endpoint",
    files: ["src/api/**"],
    gate: "bun run validate",
    model: "qwen3-coder",
    maxTurns: 25,
    policyMode: "default",
    web: true,
  };

  // Nothing on the CLI → recipe fills everything.
  const filled = parseArgs([]);

  applyRecipe(filled, recipe);
  expect(filled.files).toEqual(["src/api/**"]);
  expect(filled.accept).toBe("bun run validate");
  expect(filled.model).toBe("qwen3-coder");
  expect(filled.maxTurns).toBe(25);
  expect(filled.policyMode).toBe("default");
  expect(filled.web).toBe(true);

  // An explicit --files overrides the recipe's scope; the rest still fill.
  const overridden = parseArgs(["--files", "lib/**"]);

  applyRecipe(overridden, recipe);
  expect(overridden.files).toEqual(["lib/**"]); // CLI wins
  expect(overridden.accept).toBe("bun run validate"); // recipe fills
});

test("plan approval is narrow — a 'yes' answering a question must not implement", async () => {
  const { isPlanApproval, isApproval } = await import("../src/cli");

  expect(isPlanApproval("approve")).toBe(true);
  expect(isPlanApproval("Approved.")).toBe(true);
  expect(isPlanApproval("go")).toBe(true);
  expect(isPlanApproval("lgtm")).toBe(true);
  expect(isPlanApproval("implement")).toBe(true);

  expect(isPlanApproval("yes")).toBe(false);
  expect(isPlanApproval("y")).toBe(false);
  expect(isPlanApproval("ok")).toBe(false);
  expect(isPlanApproval("looks good, also add tests")).toBe(false);

  // The staged-web checkpoint keeps the wide form (it prompted "type 'approve'").
  expect(isApproval("yes")).toBe(true);
  expect(isApproval("ok")).toBe(true);
});

test("spinnerPhase tracks the turn's activity", async () => {
  const { spinnerPhase } = await import("../src/cli");

  expect(
    spinnerPhase({ kind: "token", task: "s", message: "x", channel: "tool" })
  ).toBe("writing");
  expect(
    spinnerPhase({
      kind: "token",
      task: "s",
      message: "x",
      channel: "reasoning",
    })
  ).toBe("thinking");
  expect(spinnerPhase({ kind: "run", task: "s", message: "$ tsc" })).toBe(
    "checking"
  );
  expect(
    spinnerPhase({ kind: "tool", task: "s", message: "↳ installing deps" })
  ).toBe("installing deps");
  expect(
    spinnerPhase({ kind: "done", task: "s", message: "green" })
  ).toBeNull();
});

// P2 (review): the spinner's inline write uses a carriage return (`\r…[2K`), which
// lands on the readline input line and clobbers what the user is typing mid-turn.
// The interactive REPL keeps a readline prompt attached for the whole session, so
// the inline write must be gated OFF there regardless of the status bar. This tests
// the gate mechanism the fix relies on: gate false → no inline write at all.
test("spinner suppresses its inline carriage-return write when the gate is off", async () => {
  const { makeSpinner } = await import("../src/cli");
  const writes: string[] = [];
  const out = {
    write: (s: string): void => {
      writes.push(s);
    },
    isTTY: true,
  };

  const spinner = makeSpinner(out);

  spinner.setInlineGate(() => false);
  spinner.tick();

  // Nothing written: no carriage return, so the readline buffer is untouched.
  expect(writes).toHaveLength(0);

  // Gate on (the non-interactive fallback) → the inline activity line IS written.
  spinner.setInlineGate(() => true);
  spinner.tick();

  expect(writes.join("")).toContain("\r");
  expect(writes.join("")).toContain("thinking");
});

// clear() must erase a line the spinner drew even if the inline gate has since
// flipped OFF — otherwise a stale spinner frame is orphaned on the readline input
// row. The guard is `drawn`, not the live gate. Regression for a tempting-but-wrong
// "add an inlineGate() check to clear() for consistency" change.
test("spinner clear() erases a drawn line even after the gate flips off", async () => {
  const { makeSpinner } = await import("../src/cli");
  const writes: string[] = [];
  const out = {
    write: (s: string): void => {
      writes.push(s);
    },
    isTTY: true,
  };

  const spinner = makeSpinner(out);

  // Gate on → tick draws the activity line (drawn = true).
  spinner.setInlineGate(() => true);
  spinner.tick();
  expect(writes.join("")).toContain("thinking");

  // Gate flips off, THEN we clear. The erase must still fire.
  spinner.setInlineGate(() => false);
  writes.length = 0;
  spinner.clear();

  expect(writes.join("")).toContain("[2K");

  // And a second clear is a no-op (nothing left drawn).
  writes.length = 0;
  spinner.clear();
  expect(writes).toHaveLength(0);
});

// The /compact handler shows progress by driving this exact path: start() runs the
// tick timer, setLabel("compacting") names it, and each tick fires onTick — which in
// the REPL repaints the pinned status bar with frameLabel() as its activity segment
// (the inline write is gated off there, so the bar IS the visible loader). Lock that
// frameLabel reflects the label and onTick fires, so the loader can't silently vanish.
test("spinner exposes a live 'compacting' activity label and repaints via onTick", async () => {
  const { makeSpinner } = await import("../src/cli");
  const out = { write: (): void => undefined, isTTY: true };
  const spinner = makeSpinner(out);

  // before start: no activity (frameLabel empty → the bar shows no loader)
  expect(spinner.frameLabel()).toBe("");

  let repaints = 0;

  spinner.onTick(() => {
    repaints += 1;
  });
  spinner.setInlineGate(() => false); // REPL gates the inline write off
  spinner.start();
  spinner.setLabel("compacting");
  spinner.tick();

  expect(spinner.frameLabel()).toContain("compacting");
  expect(repaints).toBeGreaterThan(0); // each tick repaints the status bar

  spinner.stop();
  expect(spinner.frameLabel()).toBe(""); // stopped → loader cleared
});

// Regression: a multi-line PASTE fired one readline `line` event per newline, so
// each line submitted separately — N messages, or mid-run N "↳ queued (steers the
// next turn)" notices for ONE paste. The batcher coalesces a burst (same tick)
// into a single newline-joined message.
test("createPasteBatcher coalesces a multi-line paste into one message", () => {
  const flushed: string[] = [];
  // Synchronous scheduler: run the flush immediately so the test is deterministic
  // (the burst is pushed before the scheduled flush, exactly as in one tick).
  const pending: (() => void)[] = [];
  const onLine = createPasteBatcher(
    (m) => flushed.push(m),
    (fn) => pending.push(fn)
  );

  // A paste: many lines (incl. a blank one) delivered before the tick settles.
  for (const l of ["line one", "line two", "", "line four"]) {
    onLine(l);
  }

  // Nothing flushed until the scheduled tick runs.
  expect(flushed).toEqual([]);

  pending.forEach((fn) => fn());

  expect(flushed).toEqual(["line one\nline two\n\nline four"]);
});

test("createPasteBatcher submits a single typed line unchanged, once", () => {
  const flushed: string[] = [];
  const pending: (() => void)[] = [];
  const onLine = createPasteBatcher(
    (m) => flushed.push(m),
    (fn) => pending.push(fn)
  );

  onLine("just one line");
  pending.forEach((fn) => fn());

  // A later, separate line (new tick) flushes on its own — not merged with the first.
  onLine("a second, separate message");
  pending.slice(1).forEach((fn) => fn());

  expect(flushed).toEqual(["just one line", "a second, separate message"]);
});
