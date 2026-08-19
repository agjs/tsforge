import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  allowedRoots,
  extractPathTokens,
  isAllowedSystemPath,
  isPathUnderRoot,
  isPathUnderRoots,
  outsideWorkspacePaths,
  resolveProjectPath,
  OUTSIDE_PROJECT_REJECT,
} from "../src/lib/scope";
import { readFile, runShell } from "../src/loop/tools/file-ops";
import type { IToolContext } from "../src/loop/tools/tool-context";

function toolCtx(
  cwd: string,
  extra?: { extraRoots?: readonly string[] }
): IToolContext {
  return {
    cwd,
    files: ["**/*"],
    report: () => undefined,
    task: "confine-test",
    ...(extra?.extraRoots === undefined
      ? {}
      : { extraRoots: extra.extraRoots }),
  };
}

describe("workspace-roots helpers", () => {
  test("isPathUnderRoot accepts root and descendants; rejects siblings", () => {
    const root = "/Users/ag/project";

    expect(isPathUnderRoot(root, root)).toBe(true);
    expect(isPathUnderRoot(root, `${root}/src/a.ts`)).toBe(true);
    expect(isPathUnderRoot(root, "/Users/ag/other/src/a.ts")).toBe(false);
    // Prefix trap: /Users/ag/project-evil must not count as under /Users/ag/project
    expect(isPathUnderRoot(root, "/Users/ag/project-evil/x.ts")).toBe(false);
  });

  test("isPathUnderRoots / allowedRoots fold cwd + extraRoots", () => {
    const cwd = "/work/app";
    const extra = "/work/shared";
    const roots = allowedRoots(cwd, [extra]);

    expect(isPathUnderRoots(roots, `${cwd}/a.ts`)).toBe(true);
    expect(isPathUnderRoots(roots, `${extra}/lib.ts`)).toBe(true);
    expect(isPathUnderRoots(roots, "/work/harness/packages/core/x.ts")).toBe(
      false
    );
  });

  test("isAllowedSystemPath allows common OS bins; not tmp trees or homes", () => {
    expect(isAllowedSystemPath("/usr/bin/rg")).toBe(true);
    expect(isAllowedSystemPath("/bin/ls")).toBe(true);
    // /tmp must NOT be a free-read zone — Linux os.tmpdir() lives there.
    expect(isAllowedSystemPath("/tmp/out.txt")).toBe(false);
    expect(
      isAllowedSystemPath("/Users/ag/Documents/Code/tsforge/packages/core")
    ).toBe(false);
  });

  test("outsideWorkspacePaths allows /tmp redirect targets; rejects /tmp greps", () => {
    const cwd = "/work/app";

    expect(
      outsideWorkspacePaths(cwd, "echo hi > /tmp/tsforge-scratch.txt")
    ).toEqual([]);
    expect(
      outsideWorkspacePaths(cwd, 'rg leak "/tmp/tsforge-foreign-abc"')
    ).toEqual(["/tmp/tsforge-foreign-abc"]);
  });

  test("extractPathTokens pulls quoted + unquoted absolute / ../ paths", () => {
    const tokens = extractPathTokens(
      `rg "foo" "/Users/ag/Documents/Code/tsforge/packages/core" && cat ../secret`
    );

    expect(tokens).toContain("/Users/ag/Documents/Code/tsforge/packages/core");
    expect(tokens).toContain("../secret");
  });

  test("outsideWorkspacePaths rejects bare filesystem root (find / spelunk)", () => {
    const cwd = "/work/app";

    expect(outsideWorkspacePaths(cwd, "find / -path '*tsforge*'")).toEqual([
      "/",
    ]);
    expect(outsideWorkspacePaths(cwd, "ls /")).toEqual(["/"]);
    expect(outsideWorkspacePaths(cwd, "cat /package.json")).toEqual([
      "/package.json",
    ]);
    expect(outsideWorkspacePaths(cwd, "find . -name '*.ts'")).toEqual([]);
  });

  test("outsideWorkspacePaths ignores in-project + system paths", () => {
    const cwd = "/work/app";

    expect(
      outsideWorkspacePaths(cwd, "rg pattern src && /usr/bin/true")
    ).toEqual([]);
    expect(
      outsideWorkspacePaths(
        cwd,
        'rg leak "/Users/ag/Documents/Code/tsforge/packages/core"'
      )
    ).toEqual(["/Users/ag/Documents/Code/tsforge/packages/core"]);
  });

  test("outsideWorkspacePaths ignores printf/echo path *strings*; still catches rg after &&", () => {
    const cwd = "/work/app";
    const foreign = "/Users/ag/Documents/Code/tsforge/packages/core";

    expect(
      outsideWorkspacePaths(cwd, `printf "%s\\n" "${foreign}/a.ts"`)
    ).toEqual([]);
    expect(
      outsideWorkspacePaths(cwd, `printf "ok" && rg leak "${foreign}"`)
    ).toEqual([foreign]);
  });

  test("resolveProjectPath accepts under cwd / extraRoots; rejects foreign", () => {
    const cwd = "/work/app";
    const extra = "/work/shared";

    expect(resolveProjectPath(cwd, "src/a.ts").ok).toBe(true);
    expect(resolveProjectPath(cwd, `${cwd}/src/a.ts`).ok).toBe(true);
    expect(resolveProjectPath(cwd, "../shared/x.ts", [extra]).ok).toBe(true);
    expect(
      resolveProjectPath(cwd, "/Users/ag/Documents/Code/tsforge/x").ok
    ).toBe(false);
  });
});

describe("read/run confinement", () => {
  let dir: string;
  let foreign: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-confine-"));
    foreign = await mkdtemp(join(tmpdir(), "tsforge-foreign-"));
    await writeFile(join(dir, "ok.ts"), "export const ok = 1;\n");
    await writeFile(join(foreign, "secret.ts"), "export const leak = 1;\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  });

  test("read accepts in-project relative and absolute paths", async () => {
    const ctx = toolCtx(dir);
    const viaRel = await readFile({ file: "ok.ts" }, ctx);
    const viaAbs = await readFile({ file: join(dir, "ok.ts") }, ctx);

    expect(viaRel).toContain("export const ok");
    expect(viaAbs).toContain("export const ok");
    expect(viaRel).not.toContain("REJECTED");
  });

  test("read rejects a foreign absolute path", async () => {
    const out = await readFile(
      { file: join(foreign, "secret.ts") },
      toolCtx(dir)
    );

    expect(out).toContain("REJECTED");
    expect(out).toContain(OUTSIDE_PROJECT_REJECT.slice(0, 40));
    expect(out).not.toContain("export const leak");
  });

  test("read allows a path under extraRoots", async () => {
    const out = await readFile(
      { file: join(foreign, "secret.ts") },
      toolCtx(dir, { extraRoots: [foreign] })
    );

    expect(out).toContain("export const leak");
    expect(out).not.toContain("REJECTED");
  });

  test("run rejects grep of a foreign absolute tree", async () => {
    const out = await runShell(
      {
        command: `rg "leak" "${foreign}"`,
      },
      toolCtx(dir)
    );

    expect(out).toContain("REJECTED");
    expect(out).toContain(foreign);
  });

  test("run rejects find / filesystem-root spelunk before executing", async () => {
    const out = await runShell(
      { command: "find / -path '*tsforge*no-derived*'" },
      toolCtx(dir)
    );

    expect(out).toContain("REJECTED");
    expect(out).toContain(OUTSIDE_PROJECT_REJECT.slice(0, 40));
    expect(out).toContain("/");
  });

  test("run allows in-project rg and /usr/bin paths", async () => {
    const inProject = await runShell({ command: "rg ok ok.ts" }, toolCtx(dir));
    const system = await runShell({ command: "/usr/bin/true" }, toolCtx(dir));

    expect(inProject).not.toContain("REJECTED");
    expect(system).not.toContain("REJECTED");
  });

  test("run allows paths under extraRoots", async () => {
    const out = await runShell(
      { command: `rg "leak" "${foreign}"` },
      toolCtx(dir, { extraRoots: [resolve(foreign)] })
    );

    expect(out).not.toContain("REJECTED");
    expect(out.toLowerCase()).toContain("secret");
  });
});

describe("confinement — quote-aware segmentation + word scan (F1/B2/B3/B4)", () => {
  const CWD = "/ws";

  test("F1: sed/grep expression args are NOT read as paths (the false-red)", () => {
    for (const cmd of [
      "sed -i 's|/old|/new|g' src/x.ts",
      "sed -n '/foo/,/bar/p' src/x.ts",
      "sed -i '/^import/d' src/x.ts",
      "grep -E '^(a|/tmp)' src/x.ts",
      "awk '/start/,/end/' src/x.ts",
      "rg 'foo/bar' src",
    ]) {
      expect(outsideWorkspacePaths(CWD, cmd)).toEqual([]);
    }
  });

  test("F1: a REAL foreign path under an expression command still trips (quoted or bare)", () => {
    expect(outsideWorkspacePaths(CWD, "sed -i s/a/b/ /foreign/secret")).toEqual(
      ["/foreign/secret"]
    );
    expect(outsideWorkspacePaths(CWD, "rg leak '/foreign/tree'")).toEqual([
      "/foreign/tree",
    ]);
  });

  test("B2: unquoted ~ and $HOME paths are caught (fail closed)", () => {
    expect(outsideWorkspacePaths(CWD, "cat ~/.aws/credentials")).toEqual([
      "~/.aws/credentials",
    ]);
    expect(outsideWorkspacePaths(CWD, "cat $HOME/.npmrc").length).toBe(1);
    expect(outsideWorkspacePaths(CWD, "rg secret $HOME/other").length).toBe(1);
  });

  test("B3: a ../ component anywhere in a token escapes cwd", () => {
    expect(outsideWorkspacePaths(CWD, "cat ./../foreign/x")).toEqual([
      "./../foreign/x",
    ]);
    expect(outsideWorkspacePaths(CWD, "cat src/../../foreign/x").length).toBe(
      1
    );
  });

  test("B4: echo + newline no longer exempts a following real command", () => {
    expect(
      outsideWorkspacePaths(CWD, "echo start\ncat /foreign/secret")
    ).toEqual(["/foreign/secret"]);
    expect(
      outsideWorkspacePaths(CWD, "echo $(cat /foreign/secret)").length
    ).toBe(1);
  });

  test("benign idioms stay allowed", () => {
    for (const cmd of [
      "date +%Y/%m/%d",
      "curl https://host/x",
      "git log --format=%H",
      "rg secret src/lib",
    ]) {
      expect(outsideWorkspacePaths(CWD, cmd)).toEqual([]);
    }
  });
});

describe("symlink confinement (B6)", () => {
  test("reading a workspace symlink that points OUT of the tree is rejected", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tsforge-sym-cwd-"));
    const foreign = await mkdtemp(join(tmpdir(), "tsforge-sym-foreign-"));

    try {
      await writeFile(join(foreign, "secret.txt"), "SECRET");
      await symlink(join(foreign, "secret.txt"), join(cwd, "link.txt"));
      await writeFile(join(cwd, "ok.ts"), "export const x = 1;\n");

      const viaLink = await readFile({ file: "link.txt" }, toolCtx(cwd));
      const viaReal = await readFile({ file: "ok.ts" }, toolCtx(cwd));

      // The lexical check passed link.txt (under cwd); the realpath re-check
      // catches that it resolves outside.
      expect(viaLink).toContain("REJECTED");
      expect(viaLink).not.toContain("SECRET");
      // A real in-tree file still reads.
      expect(viaReal).toContain("export const x");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(foreign, { recursive: true, force: true });
    }
  });

  test("a symlink pointing INSIDE the tree still reads (not over-blocked)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tsforge-sym-in-"));

    try {
      await writeFile(join(cwd, "real.ts"), "export const y = 2;\n");
      await symlink(join(cwd, "real.ts"), join(cwd, "alias.ts"));

      const out = await readFile({ file: "alias.ts" }, toolCtx(cwd));

      expect(out).toContain("export const y");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
