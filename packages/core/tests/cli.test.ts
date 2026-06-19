import { test, expect } from "bun:test";
import { parseArgs, isOneShot, applyRecipe } from "../src/cli";
import type { ITaskRecipe } from "../src/config/recipes";

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

test("`tsforge recipes` and `--recipe <id>` are recognized", () => {
  expect(parseArgs(["recipes"]).recipes).toBe(true);
  expect(parseArgs(["--recipe", "web-build", "build it"]).recipe).toBe(
    "web-build"
  );
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
