import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../src/loop/tools/execute-tool";
import type { IToolContext } from "../src/loop/tools/execute-tool";

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

test("edit on an EXISTING file with an unmatched oldString says the file exists + don't create", async () => {
  // Regression: the bare reason "not-found" read as "FILE not found", so the model
  // switched to `create` (rejected: already exists) and thrashed edit↔create for
  // ~4 turns. The message must disambiguate: file exists, read it, do NOT create.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    await Bun.write(join(dir, "impl.ts"), "const a = 1;\n");

    const r = await executeTool(
      {
        name: "edit",
        arguments: {
          file: "impl.ts",
          oldString: "const z = 99;",
          newString: "const z = 100;",
        },
      },
      ctx(dir, ["impl.ts"])
    );

    expect(r).toContain("REJECTED");
    expect(r).toContain("EXISTS");
    expect(r).toContain("Do NOT use `create`");
    expect(r).toContain("read");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("edit on a MISSING file tells the model to use create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const r = await executeTool(
      {
        name: "edit",
        arguments: { file: "impl.ts", oldString: "x", newString: "y" },
      },
      ctx(dir, ["impl.ts"])
    );

    expect(r).toContain("REJECTED");
    expect(r).toContain("does not exist");
    expect(r).toContain("`create`");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scaffold_ui materializes themed primitives into src/components/ui", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const r = await executeTool(
      {
        name: "scaffold_ui",
        arguments: { theme: "futuristic", components: ["card", "button"] },
      },
      ctx(dir, ["**/*"])
    );

    expect(r).toContain("futuristic");
    expect(await Bun.file(join(dir, "src/index.css")).exists()).toBe(true);
    expect(
      await Bun.file(join(dir, "src/components/ui/card.tsx")).exists()
    ).toBe(true);

    // theme is applied (futuristic card delta) + structure is intact
    const card = await Bun.file(join(dir, "src/components/ui/card.tsx")).text();

    expect(card).toContain("export function Card");
    expect(card).toContain("backdrop-blur-sm");
    expect(await Bun.file(join(dir, "src/index.css")).text()).toContain(
      "--radius: 0rem"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scaffold_ui rejects an unknown theme or empty component list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const badTheme = await executeTool(
      {
        name: "scaffold_ui",
        arguments: { theme: "neon", components: ["card"] },
      },
      ctx(dir, ["**/*"])
    );

    expect(badTheme).toContain("REJECTED");

    const noComps = await executeTool(
      { name: "scaffold_ui", arguments: { theme: "minimal", components: [] } },
      ctx(dir, ["**/*"])
    );

    expect(noComps).toContain("REJECTED");
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

test("run announces the command up-front (↳ run …) before the result event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const events: { kind: string; message: string }[] = [];
    const capturing: IToolContext = {
      cwd: dir,
      files: [],
      task: "t",
      report: (e) => events.push({ kind: e.kind, message: e.message }),
    };

    await executeTool(
      { name: "run", arguments: { command: "echo hi" } },
      capturing
    );

    const announce = events.findIndex(
      (e) => e.kind === "tool" && e.message === "↳ run echo hi"
    );
    const result = events.findIndex((e) => e.kind === "run");

    // the command is shown the instant it starts (so a slow build isn't a frozen
    // screen), and BEFORE the run-result event that carries exit code + output
    expect(announce).toBeGreaterThanOrEqual(0);
    expect(result).toBeGreaterThan(announce);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run condenses eslint JSON, aggregating a repeated rule into one line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const eslintJson = JSON.stringify([
      {
        filePath: "/x/CompaniesList.tsx",
        messages: [
          {
            severity: 2,
            line: 24,
            ruleId: "padding-line-between-statements",
            message: "Expected blank line",
          },
          {
            severity: 2,
            line: 26,
            ruleId: "padding-line-between-statements",
            message: "Expected blank line",
          },
          {
            severity: 2,
            line: 77,
            ruleId: "no-restricted-syntax",
            message: "No as casts",
          },
        ],
      },
    ]);

    const r = await executeTool(
      { name: "run", arguments: { command: `echo '${eslintJson}'` } },
      ctx(dir, [])
    );

    // The repeated padding rule collapses to ONE aggregated line (×2, L24,26)…
    expect(r).toContain("(×2)");
    expect(r).toContain("L24,26");
    // …while the lone no-as error keeps its single file:line form.
    expect(r).toContain("CompaniesList.tsx:77");
    expect(r).toContain("eslint: 3 error(s)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run condenses a successful vite build's chunk table to one line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const r = await executeTool(
      {
        name: "run",
        arguments: {
          command:
            'printf "%s\\n" "vite v6.4.3 building for production..." "✓ 212 modules transformed." "dist/assets/a.js 1kB" "dist/assets/b.js 2kB" "✓ built in 3.45s"',
        },
      },
      ctx(dir, [])
    );

    expect(r).toContain("vite build ✓");
    expect(r).toContain("212 modules");
    expect(r).toContain("2 chunks");
    expect(r).not.toContain("dist/assets/a.js"); // table elided
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run does NOT condense a FAILED vite build — the model must see the error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const r = await executeTool(
      {
        name: "run",
        arguments: {
          command:
            'printf "%s\\n" "✓ 100 modules transformed." "error: Could not resolve ./missing" "built in 1.0s"',
        },
      },
      ctx(dir, [])
    );

    expect(r).toContain("Could not resolve");
    expect(r).not.toContain("vite build ✓");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run factors the shared directory prefix out of a file listing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const base = "/agjs/code/ant/evals/runs/x/src";
    const files = [
      `${base}/routes/__root.tsx`,
      `${base}/routes/index.tsx`,
      `${base}/index.css`,
      `${base}/main.tsx`,
      `${base}/lib/result.ts`,
      `${base}/lib/collection.ts`,
      `${base}/lib/object.ts`,
    ];

    const r = await executeTool(
      {
        name: "run",
        arguments: {
          command: `printf "%s\\n" ${files.map((f) => `"${f}"`).join(" ")}`,
        },
      },
      ctx(dir, [])
    );

    // The long shared prefix appears ONCE as a header, then relative entries…
    expect(r).toContain("entries):");
    expect(r).toContain("routes/__root.tsx");
    // …and the full absolute prefix is NOT repeated on every line.
    expect(r.match(new RegExp(base.replace(/\//g, "\\/"), "g"))?.length).toBe(
      1
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run leaves NON-path output untouched (no false-positive condensing)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-exec-"));

  try {
    const r = await executeTool(
      {
        name: "run",
        arguments: {
          command:
            'printf "%s\\n" "Tests:" "1 passed" "2 passed" "3 passed" "all green" "done"',
        },
      },
      ctx(dir, [])
    );

    expect(r).toContain("all green");
    expect(r).not.toContain("entries):");
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

test("web_fetch dispatches to its handler and is permitted in plan mode", async () => {
  // readOnly (plan mode) + a bad URL: the result is web_fetch's own validation
  // message — proving the call reached the handler, NOT the plan-mode guard
  // (web tools are read-only, so plan mode allows them). No network is touched.
  const r = await executeTool(
    { name: "web_fetch", arguments: { url: "file:///etc/passwd" } },
    { cwd: ".", files: [], task: "t", report: () => undefined, readOnly: true }
  );

  expect(r).toContain("web_fetch");
  expect(r).not.toContain("plan mode");
});

test("web_search dispatches to its handler (empty query rejected, no network)", async () => {
  const r = await executeTool(
    { name: "web_search", arguments: { query: "" } },
    { cwd: ".", files: [], task: "t", report: () => undefined, readOnly: true }
  );

  expect(r).toContain("web_search");
  expect(r).not.toContain("plan mode");
});
