import { test, expect } from "bun:test";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  chmod,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFiles } from "../src/gate";
import { resolveProjectPrettierArgv } from "../src/gate/linter";
import { isWin32 } from "../src/lib/platform";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-format-scope-"));
}

// THE reported bug: the format pass rewrote the whole repo, so files the model
// never touched (already correct per the project's rules) came out with thousands
// of spurious diffs. formatFiles must rewrite ONLY the files it is handed.
test("formatFiles rewrites only the listed file, never its untouched sibling", async () => {
  const dir = await tempDir();

  try {
    const messy = "export  const   x=1";

    await writeFile(join(dir, "touched.ts"), messy);
    await writeFile(join(dir, "untouched.ts"), messy);

    await formatFiles(dir, ["touched.ts"]);

    // The listed file is formatted…
    expect(await readFile(join(dir, "touched.ts"), "utf8")).toBe(
      "export const x = 1;\n"
    );
    // …and the sibling that was NOT listed is left byte-for-byte as it was.
    expect(await readFile(join(dir, "untouched.ts"), "utf8")).toBe(messy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Fidelity: when the project ships its own prettier config, the format pass must
// produce output matching THAT config — not tsforge's built-in defaults. Prettier
// (bundled, in this dir with no local prettier) resolves the project `.prettierrc`,
// and runs LAST, so its config has the final say (single quotes, no semicolons).
test("formatFiles honors the project's prettier config over tsforge defaults", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, ".prettierrc.json"),
      JSON.stringify({ singleQuote: true, semi: false })
    );
    await writeFile(join(dir, "f.ts"), 'export const greeting = "hi"');

    await formatFiles(dir, ["f.ts"]);

    // Single-quoted and no trailing semicolon = the PROJECT's rules, not tsforge's
    // default (double quotes + semicolons).
    expect(await readFile(join(dir, "f.ts"), "utf8")).toBe(
      "export const greeting = 'hi'\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Containment: formatFiles invokes mutating formatters directly, so a caller that
// hands it an absolute path or a `../` traversal must NOT be able to rewrite files
// outside cwd. A path that escapes cwd is dropped, not formatted.
test("formatFiles refuses a path that escapes cwd (../outside)", async () => {
  const parent = await tempDir();

  try {
    const dir = join(parent, "workspace");

    await mkdir(dir, { recursive: true });
    const messy = "export  const   x=1";

    // A sibling of the workspace, reachable only by escaping cwd.
    await writeFile(join(parent, "outside.ts"), messy);

    await formatFiles(dir, ["../outside.ts"]);

    expect(await readFile(join(parent, "outside.ts"), "utf8")).toBe(messy);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// Exercises the project-prettier spawn path: when node_modules/.bin/prettier exists,
// formatFiles spawns [projectBin, ...] directly (NO "bun" prefix). A fake executable
// stands in for the project's prettier and proves it was invoked with the file args.
// POSIX-only: on win32 the project bin isn't shell-lessly spawnable, so the
// implementation deliberately uses bundled prettier (covered by the fallback test).
test.skipIf(isWin32())(
  "formatFiles spawns the project's own prettier binary directly",
  async () => {
    const dir = await tempDir();

    try {
      const binDir = join(dir, "node_modules", ".bin");

      await mkdir(binDir, { recursive: true });
      // prettier must be a real installed package (manifest present), not just a .bin shim.
      await mkdir(join(dir, "node_modules", "prettier"), { recursive: true });
      await writeFile(
        join(dir, "node_modules", "prettier", "package.json"),
        JSON.stringify({ name: "prettier", version: "3.9.6" })
      );
      // Fake prettier: appends a marker to each non-flag arg, proving it ran with the
      // file list and that the argv had no leading "bun".
      await writeFile(
        join(binDir, "prettier"),
        '#!/bin/sh\nfor a in "$@"; do case "$a" in --*) ;; *) printf "/*fmt*/\\n" >> "$a";; esac; done\n'
      );
      await chmod(join(binDir, "prettier"), 0o755);
      await writeFile(join(dir, "f.ts"), "export const x = 1;\n");

      await formatFiles(dir, ["f.ts"]);

      expect(await readFile(join(dir, "f.ts"), "utf8")).toContain("/*fmt*/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

// The eslint autofix moat must actually run — not just prettier. ESLint 10 silently
// no-ops on ABSOLUTE paths ("File ignored because outside of base path"), so formatFiles
// must hand it cwd-RELATIVE paths. `curly` adds the braces prettier never would, so this
// fails if the eslint --fix step is a no-op.
test("formatFiles applies the eslint autofix moat (curly), not just prettier", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "g.ts"),
      "export function f(x: boolean) {\n  if (x) return 1;\n  return 2;\n}\n"
    );

    await formatFiles(dir, ["g.ts"]);

    // Braces were added by eslint's `curly` autofix (prettier alone never adds them).
    expect(await readFile(join(dir, "g.ts"), "utf8")).toContain("if (x) {");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// A DIRECTORY must never reach the formatters: `prettier --write .`/`sub` expands to
// the whole (sub)tree — the #103 whole-repo rewrite in disguise. formatFiles must drop
// directory args (including "." and the workspace root) and format nothing.
test("formatFiles never formats a directory arg (., root, or subdir)", async () => {
  const dir = await tempDir();

  try {
    const messy = "export  const   x=1";

    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "a.ts"), messy);
    await writeFile(join(dir, "top.ts"), messy);

    // "." and the absolute root are directories; "sub" is a directory.
    await formatFiles(dir, [".", dir, "sub"]);

    // Nothing under them was touched.
    expect(await readFile(join(dir, "sub", "a.ts"), "utf8")).toBe(messy);
    expect(await readFile(join(dir, "top.ts"), "utf8")).toBe(messy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// macOS tmpdir dualism: cwd may be the logical `/var/…` form while a caller passes an
// already-resolved `/private/var/…` path. Relativizing against the real root keeps the
// eslint moat alive (a `../../private/var/…` arg would make ESLint no-op again).
test("formatFiles still runs the eslint moat for a realpath-form absolute input", async () => {
  const logicalDir = await tempDir();
  const realDir = await realpath(logicalDir);

  try {
    await writeFile(
      join(logicalDir, "g.ts"),
      "export function f(x: boolean) {\n  if (x) return 1;\n  return 2;\n}\n"
    );

    // cwd = logical form; the file path = resolved (real) form. This is the dualism.
    await formatFiles(logicalDir, [join(realDir, "g.ts")]);

    expect(await readFile(join(logicalDir, "g.ts"), "utf8")).toContain(
      "if (x) {"
    );
  } finally {
    await rm(logicalDir, { recursive: true, force: true });
  }
}, 30_000);

// Security: a contained file whose NAME looks like a flag (`--config=x.ts`) must be
// formatted as a PATH, not interpreted as a formatter option (which could load
// repo-controlled config). The `--` argv terminator guarantees this — without it, the
// formatters treat the name as an option and leave the file untouched, so "it got
// formatted" is the proof `--` is present and working.
test("formatFiles formats a flag-named file (the -- terminator holds)", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "--config=x.ts"), "export  const   x=1");

    await formatFiles(dir, ["--config=x.ts"]);

    expect(await readFile(join(dir, "--config=x.ts"), "utf8")).toBe(
      "export const x = 1;\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// The escape guard rejects only a real parent ref (`..`, `../…`), NOT a legitimately
// contained filename that merely starts with two dots. `..draft.ts` must still format.
test("formatFiles formats a contained file whose name starts with '..'", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "..draft.ts"), "export  const   x=1");

    await formatFiles(dir, ["..draft.ts"]);

    expect(await readFile(join(dir, "..draft.ts"), "utf8")).toBe(
      "export const x = 1;\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// .mts / .cts are TypeScript source — the strict eslint --fix moat must run on them too,
// not just prettier. curly braces are the tell (prettier never adds them).
test("formatFiles applies the eslint moat to a .mts file", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "g.mts"),
      "export function f(x: boolean) {\n  if (x) return 1;\n  return 2;\n}\n"
    );

    await formatFiles(dir, ["g.mts"]);

    expect(await readFile(join(dir, "g.mts"), "utf8")).toContain("if (x) {");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// Monorepo: a package subdir with prettier hoisted to the workspace root's node_modules
// must resolve the hoisted binary (Node module resolution), not fall back to bundled.
test.skipIf(isWin32())(
  "resolveProjectPrettierArgv finds a workspace-hoisted prettier from a package subdir",
  async () => {
    const root = await tempDir();

    try {
      // prettier installed only at the workspace ROOT.
      const rootBinDir = join(root, "node_modules", ".bin");

      await mkdir(rootBinDir, { recursive: true });
      await writeFile(join(rootBinDir, "prettier"), "#!/usr/bin/env node\n");
      await mkdir(join(root, "node_modules", "prettier"), { recursive: true });
      await writeFile(
        join(root, "node_modules", "prettier", "package.json"),
        JSON.stringify({ name: "prettier", version: "3.9.6" })
      );

      // The package subdir has no prettier of its own.
      const pkg = join(root, "packages", "app");

      await mkdir(pkg, { recursive: true });

      const argv = await resolveProjectPrettierArgv(pkg);

      expect(argv).toEqual([join(rootBinDir, "prettier")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test("formatFiles is a no-op on an empty list and skips a missing path", async () => {
  const dir = await tempDir();

  try {
    // Neither call should throw; a missing path is filtered, not handed to a tool.
    await formatFiles(dir, []);
    await formatFiles(dir, ["does-not-exist.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectPrettierArgv falls back to the bundled prettier when the project has none", async () => {
  const dir = await tempDir();

  try {
    const argv = await resolveProjectPrettierArgv(dir);

    // Bundled path: `bun <bundled-prettier>` — two args, run via bun, not a project bin.
    expect(argv[0]).toBe("bun");
    expect(argv).toHaveLength(2);
    expect(argv[1]).not.toContain(join(dir, "node_modules"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Security: a lone `.bin/prettier` shim WITHOUT an installed prettier package (no
// node_modules/prettier/package.json) must NOT be auto-executed — fall back to bundled.
test.skipIf(isWin32())(
  "resolveProjectPrettierArgv ignores a lone .bin/prettier shim with no installed package",
  async () => {
    const dir = await tempDir();

    try {
      const binDir = join(dir, "node_modules", ".bin");

      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, "prettier"), "#!/bin/sh\nexit 0\n");
      // NOTE: no node_modules/prettier/package.json — the shim is not a real install.

      const argv = await resolveProjectPrettierArgv(dir);

      expect(argv[0]).toBe("bun"); // bundled, not the planted shim
      expect(argv).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

// POSIX: a backslash is a legal filename character. formatFiles must NOT normalize `a\b.ts`
// to `a/b.ts` — doing so would retarget a DIFFERENT file. The safety guarantee is that the
// distinct `a/b.ts` is never formatted as a side effect (under the buggy normalize path it
// WOULD be). Whether the odd backslash file itself formats is moot — the tools' glob layer
// escapes backslashes — so we assert only the no-retarget property.
test.skipIf(isWin32())(
  "formatFiles does not normalize a POSIX backslash into a retargeted sibling",
  async () => {
    const dir = await tempDir();

    try {
      const messy = "export  const   x=1";

      await writeFile(join(dir, "a\\b.ts"), messy); // literal backslash in the name
      await mkdir(join(dir, "a"), { recursive: true });
      await writeFile(join(dir, "a", "b.ts"), messy); // the distinct a/b.ts

      await formatFiles(dir, ["a\\b.ts"]);

      // a/b.ts — the file `\`→`/` normalization would have hit — is left untouched.
      expect(await readFile(join(dir, "a", "b.ts"), "utf8")).toBe(messy);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000
);

test.skipIf(isWin32())(
  "resolveProjectPrettierArgv prefers the project's own prettier binary when present",
  async () => {
    const dir = await tempDir();

    try {
      const binDir = join(dir, "node_modules", ".bin");

      await mkdir(binDir, { recursive: true });
      await mkdir(join(dir, "node_modules", "prettier"), { recursive: true });
      await writeFile(
        join(dir, "node_modules", "prettier", "package.json"),
        JSON.stringify({ name: "prettier", version: "3.9.6" })
      );
      const projectBin = join(binDir, "prettier");

      await writeFile(projectBin, "#!/usr/bin/env node\n");

      const argv = await resolveProjectPrettierArgv(dir);

      // The project's own prettier carries its version + can resolve shared/extended
      // configs from the project's node_modules; we run it directly.
      expect(argv).toEqual([projectBin]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

// Symlink escape: a symlink UNDER cwd that points to a file OUTSIDE the workspace must
// not let a formatter rewrite the external target. realpath-based containment resolves
// the link and drops it.
test.skipIf(isWin32())(
  "formatFiles refuses an in-workspace symlink that points outside cwd",
  async () => {
    const parent = await tempDir();

    try {
      const dir = join(parent, "workspace");

      await mkdir(dir, { recursive: true });
      const messy = "export  const   x=1";

      await writeFile(join(parent, "outside.ts"), messy);
      // link lives inside the workspace but resolves to the outside file.
      await symlink(join(parent, "outside.ts"), join(dir, "link.ts"));

      await formatFiles(dir, ["link.ts"]);

      expect(await readFile(join(parent, "outside.ts"), "utf8")).toBe(messy);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
);
