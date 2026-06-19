import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doHashlineEdit } from "../src/loop/tools/edit-hashline";
import { parsePackageSpecs } from "../src/loop/tools/add-dependency";
import { isReadOnlyCommand } from "../src/loop/tools/file-ops";
import { computeFileHash } from "../src/files/hashline-format";
import type { IToolContext } from "../src/loop/tools/tool-context";

function ctx(cwd: string, files: string[]): IToolContext {
  return { cwd, files, task: "t", report: () => undefined };
}

// P1 #1 — edit_lines must NOT write outside the editable scope. doEdit guards
// with normalizeWorkspacePath + writable; edit_lines must enforce the same.
test("edit_lines refuses to write a `../` path outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsforge-wp-"));

  try {
    const workspace = join(root, "workspace");
    const victimDir = join(root, "victim");
    const victim = join(victimDir, "target.ts");
    const original = "secret = 1\n";

    await Bun.write(victim, original);
    await Bun.write(join(workspace, "in-scope.ts"), "ok\n");

    const hash = computeFileHash(original);
    const input = `¶../victim/target.ts#${hash}\nreplace 1..1:\n+PWNED`;

    const out = await doHashlineEdit(
      { file: "../victim/target.ts", input },
      ctx(workspace, ["**/*.ts"])
    );

    // The out-of-scope file must be untouched and the call rejected.
    expect(await Bun.file(victim).text()).toBe(original);
    expect(out).toMatch(/REJECTED|out of scope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// P1 #2 — version specs must not carry shell-active chars. `bun add` is built as
// a shell string, so `<`/`>` enable redirection (`left-pad@>=proof.txt`).
test("parsePackageSpecs rejects shell-redirection metacharacters", () => {
  expect(parsePackageSpecs("left-pad@>=proof.txt")).toBeNull();
  expect(parsePackageSpecs("pkg@>1.0")).toBeNull();
  expect(parsePackageSpecs("pkg@<1.0")).toBeNull();
  // legitimate ranges still validate
  expect(parsePackageSpecs("react@^19.0.0")).toEqual(["react@^19.0.0"]);
  expect(parsePackageSpecs("zod@3")).toEqual(["zod@3"]);
});

// P1 #3 — plan-mode read-only run must not classify a writing git flag as safe.
test("isReadOnlyCommand rejects git --output / -o", () => {
  expect(isReadOnlyCommand("git diff --output=/tmp/x")).toBe(false);
  expect(isReadOnlyCommand("git diff --output /tmp/x")).toBe(false);
  expect(isReadOnlyCommand("git diff -o /tmp/x")).toBe(false);
  // a genuinely read-only diff still passes
  expect(isReadOnlyCommand("git diff HEAD~1")).toBe(true);
  expect(isReadOnlyCommand("git status")).toBe(true);
});
