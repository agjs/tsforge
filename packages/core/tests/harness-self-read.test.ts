import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isForeignHarnessRead,
  foreignHarnessReadRefusal,
} from "../src/lib/scope";
import { readFile, runShell } from "../src/loop/tools/file-ops";

/** This test file lives inside the harness, so its own directory is a path the
 *  predicate must treat as harness source. */
const HARNESS_FILE = "src/loop/feedback/rule-docs.ts";
const HARNESS_ROOT = resolve(import.meta.dir, "..");
/** The monorepo root — `packages/core` is only one of the harness's roots. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

function ctx(cwd: string) {
  return {
    cwd,
    files: ["**/*"],
    task: "t",
    report: () => {
      // The refusal is asserted through the returned text, not the transcript.
    },
  };
}

test("reading the harness's own source from another workspace is refused", () => {
  expect(
    isForeignHarnessRead(
      "/tmp/some-other-project",
      join(HARNESS_ROOT, HARNESS_FILE)
    )
  ).toBe(true);
});

test("the same read is allowed when the harness IS the workspace", () => {
  // Developing tsforge with tsforge is the normal case here — its source is the
  // project in hand, not an escape hatch out of a gate.
  expect(isForeignHarnessRead(HARNESS_ROOT, HARNESS_FILE)).toBe(false);
});

test("a workspace nested inside the harness may still read it", () => {
  expect(
    isForeignHarnessRead(
      join(HARNESS_ROOT, "src"),
      join(HARNESS_ROOT, HARNESS_FILE)
    )
  ).toBe(false);
});

test("an ordinary project file is unaffected", () => {
  expect(isForeignHarnessRead("/tmp/some-other-project", "src/index.ts")).toBe(
    false
  );
});

test("a sibling directory sharing the harness's name prefix is not harness source", () => {
  // `contains` compares segments: `/code/tsforge-notes` is not inside
  // `/code/tsforge`, and a prefix test would have wrongly refused it.
  expect(isForeignHarnessRead("/tmp/other", `${REPO_ROOT}-notes/a.ts`)).toBe(
    false
  );
});

test("files at the monorepo root are harness source too", () => {
  // `packages/` carries no manifest, so climbing "while ancestors are packages"
  // stopped at packages/core and left the repo root readable.
  expect(isForeignHarnessRead("/tmp/other", join(REPO_ROOT, "README.md"))).toBe(
    true
  );
});

test("a sibling package inside the monorepo may read the harness", () => {
  // Disjoint from packages/core, but plainly harness work — the overlap test
  // has to consider every root, not each one in isolation.
  expect(
    isForeignHarnessRead(
      join(REPO_ROOT, "packages", "other"),
      join(HARNESS_ROOT, HARNESS_FILE)
    )
  ).toBe(false);
});

test("the run tool refuses a shell command that reads the harness source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-shell-read-"));

  try {
    const out = await runShell(
      { command: `cat ${join(HARNESS_ROOT, HARNESS_FILE)}` },
      ctx(dir)
    );

    expect(out).toContain("not part of this workspace");
    expect(out).not.toContain("export function ruleHelp");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the run tool refuses a grep into the harness source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-shell-grep-"));

  try {
    const out = await runShell(
      { command: `rg ruleHelp ${join(HARNESS_ROOT, "src")}` },
      ctx(dir)
    );

    expect(out).toContain("not part of this workspace");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the run tool still runs an ordinary workspace command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-shell-ok-"));

  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await Bun.write(join(dir, "src", "a.ts"), "export const a = 1;\n");

    const out = await runShell({ command: "cat src/a.ts" }, ctx(dir));

    expect(out).toContain("export const a = 1;");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the refusal names what to do instead of reading the source", () => {
  const message = foreignHarnessReadRefusal("src/rule-packs/x.ts");

  // Pointing the model back at the feedback it already had is what fails; the
  // refusal has to say the guidance is the bug and to report it.
  expect(message).toContain("guidance is the bug");
  expect(message.toLowerCase()).toContain("closest correct approach");
});

test("the read tool returns the refusal instead of the file's bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-foreign-read-"));

  try {
    const out = await readFile(
      { file: join(HARNESS_ROOT, HARNESS_FILE) },
      ctx(dir)
    );

    expect(out).toContain("not part of this workspace");
    // The real file opens with its imports; none of it may leak through.
    expect(out).not.toContain("export function ruleHelp");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the read tool still reads an ordinary workspace file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ordinary-read-"));

  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await Bun.write(join(dir, "src", "a.ts"), "export const a = 1;\n");

    const out = await readFile({ file: "src/a.ts" }, ctx(dir));

    expect(out).toContain("export const a = 1;");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
