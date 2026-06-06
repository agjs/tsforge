import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../src/loop/execute-tool";
import type { IToolContext } from "../src/loop/execute-tool";

function ctx(cwd: string, files: string[]): IToolContext {
  return { cwd, files, task: "t", report: () => undefined };
}

test("create/edit are scope-enforced to the task's editable files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const r = await executeTool(
      { name: "create", arguments: { file: "secret.ts", content: "x" } },
      ctx(dir, ["impl.ts"])
    );

    expect(r).toContain("REJECTED");
    expect(await Bun.file(join(dir, "secret.ts")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scratch/ files are writable even when not in scope — for experiments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    await mkdir(join(dir, "scratch"), { recursive: true });

    const r = await executeTool(
      {
        name: "create",
        arguments: { file: "scratch/check.ts", content: "console.log(1);\n" },
      },
      ctx(dir, ["impl.ts"])
    );

    expect(r).not.toContain("REJECTED");
    expect(await Bun.file(join(dir, "scratch/check.ts")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an oversized edit — forces surgical changes, not whole-function rewrites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const big = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n");

    await Bun.write(join(dir, "impl.ts"), big);

    const r = await executeTool(
      {
        name: "edit",
        arguments: { file: "impl.ts", oldString: big, newString: "tiny" },
      },
      ctx(dir, ["impl.ts"])
    );

    expect(r).toContain("too large");
    expect(await Bun.file(join(dir, "impl.ts")).text()).toBe(big); // unchanged
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edit applies a multi-site batch in one call (per-site, not whole-file)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    await Bun.write(
      join(dir, "impl.ts"),
      "const a = new Array(n).fill(0);\nconst b = new Array(n).fill(base);\n"
    );

    const r = await executeTool(
      {
        name: "edit",
        arguments: {
          file: "impl.ts",
          edits: [
            {
              oldString: "new Array(n).fill(0)",
              newString: "Array.from({ length: n }, () => 0)",
            },
            {
              oldString: "new Array(n).fill(base)",
              newString: "Array.from({ length: n }, () => base)",
            },
          ],
        },
      },
      ctx(dir, ["impl.ts"])
    );

    expect(r).toContain("2 changes");
    expect(await Bun.file(join(dir, "impl.ts")).text()).not.toContain(
      "new Array("
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the size cap is per-replacement — a huge single replacement is still rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const big = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n");

    await Bun.write(join(dir, "impl.ts"), big);

    const r = await executeTool(
      {
        name: "edit",
        arguments: {
          file: "impl.ts",
          edits: [{ oldString: big, newString: "tiny" }],
        },
      },
      ctx(dir, ["impl.ts"])
    );

    expect(r).toContain("too large");
    expect(await Bun.file(join(dir, "impl.ts")).text()).toBe(big); // unchanged
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run executes a command and returns its output + exit code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const r = await executeTool(
      { name: "run", arguments: { command: "echo scratch-works" } },
      ctx(dir, [])
    );

    expect(r).toContain("scratch-works");
    expect(r).toContain("exit 0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run attaches rule-fix guidance when its output shows lint/type errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    // A failing command whose output mentions TS2532 → guidance is appended.
    const r = await executeTool(
      {
        name: "run",
        arguments: {
          command:
            'echo "x.ts(1,1): error TS2532: possibly undefined" && exit 1',
        },
      },
      ctx(dir, [])
    );

    expect(r).toContain("Fix guidance");
    expect(r).toContain("const x = arr[i]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
