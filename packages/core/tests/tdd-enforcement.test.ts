import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/loop";
import { scripted, createStep, STOP } from "./stub-provider";

// Regression for the bug where TDD enforcement no-op'd on generated/non-git
// projects: it was scoped to `git diff`, which is empty without a git repo, so a
// generated app shipped with zero tests and a green gate. The fix scopes to the
// files the AGENT actually wrote (ctx.touched), which works without git.

afterEach(() => {
  delete process.env.TSFORGE_TDD;
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "tdd-nongit-"));

  // Deliberately NOT a git repo. tsconfig present so it's a real TS project.
  writeFileSync(
    join(dir, "tsconfig.json"),
    '{"compilerOptions":{"strict":true,"skipLibCheck":true},"include":["*.ts"]}'
  );

  return dir;
}

const IMPL = createStep(
  "calc.ts",
  "export function add(a: number, b: number): number {\n  return a + b;\n}\n"
);
const TEST = createStep(
  "calc.test.ts",
  'import { test, expect } from "bun:test";\nimport { add } from "./calc";\ntest("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n'
);
const TASK = { id: "1", accept: "test -f calc.ts", files: ["**/*"] };

test("a created .ts logic file WITHOUT a test stays red in a non-git project", async () => {
  const dir = project();

  try {
    // Only the impl, never a test → test-sibling (error under default TDD) keeps
    // the gate red, so it never reaches done. This is the case that used to pass.
    const r = await runTask(TASK, dir, scripted([IMPL, STOP]));

    expect(r.status).not.toBe("done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Steering keeps a stalled run alive through the ladder before parking (~4× the
  // old cycle count), so allow more wall-clock than the 5s default.
}, 20000);

test("adding the test makes the same non-git project go green", async () => {
  const dir = project();

  try {
    // Impl + co-located test → test-sibling satisfied → done. That this reaches
    // done proves no OTHER meta-rule is blocking; the only difference from the
    // case above is the test, so the red there is specifically test enforcement.
    const r = await runTask(TASK, dir, scripted([IMPL, TEST, STOP]));

    expect(r.status).toBe("done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opting out with TSFORGE_TDD=0 lets the untested .ts file pass", async () => {
  process.env.TSFORGE_TDD = "0";
  const dir = project();

  try {
    const r = await runTask(TASK, dir, scripted([IMPL, STOP]));

    expect(r.status).toBe("done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
