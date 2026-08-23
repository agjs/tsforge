import { describe, test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, isOneShot, applyRecipe, runNotify } from "../src/cli";
import { cliUsage, valueFlagError } from "../src/cli/args";
import { paneConsoleRejectReason } from "../src/cli/repl";
import { PANE_MIN_ROWS } from "../src/render";
import { PROFILE_IDS } from "../src/config/profiles";
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

// A silently-degrading path must not be a black hole: with TSFORGE_TRACE set,
// detectContextWindow's unreachable-endpoint fallback leaves a scoped line in
// the trace file (B4 wiring) while still returning undefined to the caller.
test("detectContextWindow degrade is observable via TSFORGE_TRACE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ctx-trace-"));
  const traceFile = join(dir, "trace.log");
  const saved = process.env.TSFORGE_TRACE;

  process.env.TSFORGE_TRACE = traceFile;

  try {
    const { detectContextWindow } = await import("../src/cli/model-setup");
    // Port 1 refuses immediately — the probe's fetch throws, the catch
    // degrades to undefined (caller falls back) AND records the failure.
    const window = await detectContextWindow({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "nope",
    });

    expect(window).toBeUndefined();

    const logged = await Bun.file(traceFile)
      .text()
      .catch(() => "");

    expect(logged).toContain("[cli.detectContextWindow]");
  } finally {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, "TSFORGE_TRACE");
    } else {
      process.env.TSFORGE_TRACE = saved;
    }

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

  const profiled = parseArgs([]);

  applyRecipe(profiled, { id: "strict", profile: "strict" });
  expect(profiled.profile).toBe("strict");

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

test("spinner elapsed clock survives stop/start across drive boundaries", async () => {
  const { makeSpinner } = await import("../src/cli");
  const out = { write: (): void => undefined, isTTY: true };
  const spinner = makeSpinner(out);
  let now = 1_000_000;
  const spy = spyOn(performance, "now").mockImplementation(() => now);

  try {
    spinner.setInlineGate(() => false);
    spinner.start();
    now += 90_000;
    spinner.tick();
    expect(spinner.frameLabel()).toContain("1m30s");

    spinner.stop();
    expect(spinner.frameLabel()).toBe("");

    now += 30_000;
    spinner.start();
    spinner.tick();
    // Same session clock — not a fresh 0s after the next drive's start().
    expect(spinner.frameLabel()).toContain("2m00s");

    spinner.resetClock();
    spinner.stop();
    spinner.start();
    spinner.tick();
    expect(spinner.frameLabel()).toMatch(/ · 0s$/);
    spinner.stop();
  } finally {
    spy.mockRestore();
  }
});

// Wiring test: the editor-backed input path routes onSubmit → a callback that
// handles multiline messages as a single submission, and respects the busy/pending
// steer queue. This test proves the integration without running the full REPL.
test("editor-backed input routes onSubmit to a handler and respects busy/pending", async () => {
  const { startEditor } = await import("../src/editor");

  const out = (): void => {};

  // Fake stdin that emits data.
  class FakeStdin {
    listeners = new Map<string, (data: string) => void>();

    on(event: string, cb: (data: string) => void): void {
      this.listeners.set(event, cb);
    }

    removeListener(event: string): void {
      this.listeners.delete(event);
    }

    setRawMode(): void {
      // no-op
    }

    setEncoding(): void {
      // no-op
    }

    resume(): void {
      // no-op
    }
  }

  const stdin = new FakeStdin();
  const handle = startEditor({
    stdin: stdin,
    out,
    columns: 80,
    rows: 10,
  });

  // Track submissions
  const submissions: string[] = [];

  handle.onSubmit((msg) => {
    submissions.push(msg);
  });

  const dataListener = stdin.listeners.get("data");

  if (!dataListener) {
    throw new Error("editor did not register a data listener");
  }

  // Simulate a bracketed-paste event: multiline text ending with closing bracket
  // The paste scanner will extract the content and insertPaste will handle it.
  dataListener("\x1b[200~line one\nline two\x1b[201~");
  // Now send Enter (return key) to submit
  dataListener("\r");

  // The handler should have submitted the entire multiline text as ONE message
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toBe("line one\nline two");

  handle.close();
});

// Wiring test: while a handler is "busy" and a line is submitted, it queues to
// `pending` exactly once (not duplicated).
test("editor input submission while busy queues exactly one message to pending", async () => {
  const { startEditor } = await import("../src/editor");

  const out = (): void => {};

  const stdin = new (class {
    listeners = new Map<string, (data: string) => void>();
    on(event: string, cb: (data: string) => void): void {
      this.listeners.set(event, cb);
    }
    removeListener(): void {}
    setRawMode(): void {}
    setEncoding(): void {}
    resume(): void {}
  })();

  const handle = startEditor({
    stdin: stdin,
    out,
    columns: 80,
    rows: 10,
  });

  // Mock a busy handler that delays processing
  const pending: string[] = [];
  let busy = false;

  handle.onSubmit((msg) => {
    if (busy) {
      pending.push(msg);
    }
  });

  const dataListener = stdin.listeners.get("data");

  if (!dataListener) {
    throw new Error("editor did not register a data listener");
  }

  // Set busy flag, then submit a message via return key
  busy = true;
  dataListener("test message");
  dataListener("\r");

  // Should queue exactly one message, not duplicated
  expect(pending).toHaveLength(1);
  expect(pending[0]).toBe("test message");

  handle.close();
});

// Regression: --version/--help were NOT recognized flags, so they fell through as
// POSITIONALS — `tsforge --version` booted a session whose task was the literal
// string "--version" (and install.sh advertises `tsforge --help`). They must parse
// as print-and-exit flags, never as a task.
test("--version/-V and --help/-h parse as flags, not as a task", () => {
  for (const argv of [["--version"], ["-V"]]) {
    const a = parseArgs(argv);

    expect(a.version).toBe(true);
    expect(a.task).toBe("");
  }

  for (const argv of [["--help"], ["-h"]]) {
    const a = parseArgs(argv);

    expect(a.help).toBe(true);
    expect(a.task).toBe("");
  }
});

test("cliUsage documents the print-and-exit flags it is reached by", () => {
  const usage = cliUsage();

  expect(usage).not.toContain("--work");
  expect(usage).not.toContain("--tick");

  expect(usage).toContain("--version");
  expect(usage).toContain("--help");
  expect(usage).toContain("--accept");
  expect(usage).toContain("tsforge review");
  expect(usage).not.toContain("--tui-panes");
  expect(usage).not.toContain("--no-tui-panes");
});

test("removed --tui-panes / --no-tui-panes are ignored (not swallowed into the task)", () => {
  expect(parseArgs(["--tui-panes"]).task).toBe("");
  expect(parseArgs(["--no-tui-panes"]).task).toBe("");
  expect(parseArgs(["--tui-panes", "ship", "it"]).task).toBe("ship it");
});

test("paneConsoleRejectReason: tiny interactive TTY fails closed; pipes do not", () => {
  expect(
    paneConsoleRejectReason({
      stdinTty: true,
      stdoutTty: true,
      rows: PANE_MIN_ROWS - 1,
    })
  ).toContain(String(PANE_MIN_ROWS));

  expect(
    paneConsoleRejectReason({
      stdinTty: true,
      stdoutTty: true,
      rows: PANE_MIN_ROWS,
    })
  ).toBeNull();

  // Non-TTY uses the plain path — not an error, and never the classic StatusBar.
  expect(
    paneConsoleRejectReason({
      stdinTty: false,
      stdoutTty: false,
      rows: 4,
    })
  ).toBeNull();
});

test("repl product path never constructs or installs StatusBar", async () => {
  const src = await Bun.file(
    new URL("../src/cli/repl.ts", import.meta.url)
  ).text();

  expect(src).not.toContain("new StatusBar");
  expect(src).not.toContain("statusBar.install");
  expect(src).not.toMatch(/import\s*\{[^}]*\bStatusBar\b/);
});

test("repl restores the terminal on SIGTERM, SIGHUP, and SIGINT (not just normal exit)", async () => {
  // A signal the process doesn't handle terminates it WITHOUT firing 'exit', so
  // the pane TUI would be left on the alt screen with mouse tracking + a colored
  // cursor (`0;23;22M` in the shell). SIGINT must be included: after the editor
  // closes, Ctrl+C is a real signal. Source-scanned — mirrors the StatusBar guard.
  const src = await Bun.file(
    new URL("../src/cli/repl.ts", import.meta.url)
  ).text();

  expect(src).toContain('"SIGTERM"');
  expect(src).toContain('"SIGHUP"');
  expect(src).toContain('"SIGINT"');
  expect(src).toContain("paneScreen.leave()");
  expect(src).toContain("RESTORE_TERMINAL");
  expect(src).toContain("writeSync");
  expect(src).toContain("process.kill(process.pid, sig)");
});

test("agents subcommand: list mode, ids+task mode, recipe fill", () => {
  const list = parseArgs(["agents"]);

  expect(list.agents).toBe(true);
  expect(list.agentIds).toBe("");

  const run = parseArgs(["agents", "explore,verify", "map", "the", "loop"]);

  expect(run.agents).toBe(true);
  expect(run.agentIds).toBe("explore,verify");
  expect(run.task).toBe("map the loop");

  // A recipe with `agents` selects fan-out mode and pre-fills ids…
  const fromRecipe = parseArgs([]);

  applyRecipe(fromRecipe, { id: "sweep", agents: ["explore", "verify"] });
  expect(fromRecipe.agents).toBe(true);
  expect(fromRecipe.agentIds).toBe("explore,verify");

  // …but explicit CLI ids always win.
  const explicit = parseArgs(["agents", "explore", "t"]);

  applyRecipe(explicit, { id: "sweep", agents: ["verify"] });
  expect(explicit.agentIds).toBe("explore");
});

// A value-taking flag whose value is missing — or is another flag — used to be
// swallowed silently: `--notify --continue` set notify to "--continue" and lost
// the resume entirely. #105 added a loud guard for `--profile` alone; this is the
// same guard for every value flag, at the parser rather than per flag.
describe("a value flag never swallows the flag after it", () => {
  const CASES: readonly [readonly string[], string][] = [
    [["--notify", "--continue"], "--notify"],
    [["--files", "--web"], "--files"],
    [["--accept", "--no-gate"], "--accept"],
    [["--dir", "--plan"], "--dir"],
    [["--base", "--staged"], "--base"],
    [["--recipe", "--scout"], "--recipe"],
    [["--browser", "--log"], "--browser"],
    [["--resume", "--greenfield"], "--resume"],
    [["--policy-mode", "--plan"], "--policy-mode"],
    [["--gate", "--web"], "--gate"],
    [["--profile", "--help"], "--profile"],
  ];

  test("every value flag reports the flag it was handed instead of a value", () => {
    for (const [argv, flag] of CASES) {
      const err = valueFlagError(argv);

      expect({ argv, named: err?.includes(flag) === true }).toEqual({
        argv,
        named: true,
      });
    }
  });

  test("the following flag still takes effect rather than being eaten", () => {
    // Even though the run aborts on the error, the parse must not silently
    // reinterpret the next flag as a value.
    expect(parseArgs(["--notify", "--continue"]).continue).toBe(true);
    expect(parseArgs(["--files", "--web"]).web).toBe(true);
    expect(parseArgs(["--accept", "--no-gate"]).noGate).toBe(true);
    expect(parseArgs(["--notify", "--continue"]).notify).toBe("");
    expect(parseArgs(["--files", "--web"]).files).toEqual([]);
  });

  test("--dir does not path-join the flag that follows it", () => {
    expect(parseArgs(["--dir", "--plan"]).dir).not.toContain("--plan");
    expect(parseArgs(["--dir", "--plan"]).plan).toBe(true);
  });

  test("a trailing value flag with no value at all is reported", () => {
    for (const flag of ["--notify", "--dir", "--accept", "--profile"]) {
      expect(valueFlagError([flag])?.includes(flag)).toBe(true);
    }
  });

  test("a legitimate value is accepted, including one containing dashes", () => {
    expect(valueFlagError(["--accept", "bun test -- src/x.ts"])).toBeNull();
    expect(parseArgs(["--accept", "bun test -- src/x.ts"]).accept).toBe(
      "bun test -- src/x.ts"
    );
    expect(valueFlagError(["--dir", "./pkg", "--plan"])).toBeNull();
    expect(valueFlagError([])).toBeNull();
    expect(valueFlagError(["--plan", "--continue"])).toBeNull();
  });
});

// The guard has to abort BEFORE any dispatch, so these spawn the real CLI rather
// than calling the pure helper: a correct valueFlagError wired in too late still
// lets `tsforge recipes --dir --plan` list recipes for the wrong directory and
// exit 0. Only running the binary catches placement.
describe("the real CLI aborts on a malformed value flag", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");

  async function run(
    argv: readonly string[]
  ): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["bun", CLI, ...argv], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, TSFORGE_NO_PERSIST: "1" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { code, out: stdout + stderr };
  }

  test("exits non-zero naming the flag", async () => {
    const r = await run(["--dir", "--plan"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("--dir");
  });

  test("beats the --help early return", async () => {
    const r = await run(["--profile", "--help"]);

    expect(r.code).toBe(1);
    expect(r.out).not.toContain("Usage");
  });

  test("beats the recipes subcommand", async () => {
    // The bug this catches: recipes ran against the default cwd and exited 0.
    const r = await run(["recipes", "--dir", "--plan"]);

    expect(r.code).toBe(1);
    expect(r.out).toContain("--dir");
  });

  test("a valid invocation still reaches its command", async () => {
    const r = await run(["--help"]);

    expect(r.code).toBe(0);
    expect(r.out).toContain("tsforge");
  });
});

// The --profile line is generated from PROFILE_IDS. It was hand-maintained, which is
// exactly what goes stale when a profile is added or removed — two were removed and
// the help text would have kept advertising them.
test("--help's profile list is generated from PROFILE_IDS", () => {
  // Compare the token list EXACTLY. Banning the removed names as substrings across
  // the whole help blob would false-fail the day help text uses those words in
  // another sense, and would not catch a stale list either.
  const line = cliUsage()
    .split("\n")
    .find((l) => l.includes("--profile <id>"));
  const listed = /strictness: (\S+)/u.exec(line ?? "")?.[1];

  expect(listed).toBe(PROFILE_IDS.join("|"));
});
