import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";
import {
  twinTestPath,
  makeDualExtensionTestGuard,
  makeBoringstackBuildGuard,
} from "../src/loop/boringstack/dual-extension-guard";
import { composeGuards, type EditGuard } from "../src/loop/tools/tool-context";

describe("twinTestPath", () => {
  test("maps .test.tsx ↔ .test.ts, and returns null for non-test files", () => {
    expect(twinTestPath("src/x/A.test.tsx")).toBe("src/x/A.test.ts");
    expect(twinTestPath("src/x/A.test.ts")).toBe("src/x/A.test.tsx");
    expect(twinTestPath("src/x/A.tsx")).toBeNull(); // component, not a test
    expect(twinTestPath("src/x/A.ts")).toBeNull();
    expect(twinTestPath("src/x/A.test.js")).toBeNull();
  });
});

describe("makeDualExtensionTestGuard", () => {
  async function withCwd(
    run: (cwd: string, guard: EditGuard) => Promise<void>
  ): Promise<void> {
    const cwd = await mkdtemp(join(tmpdir(), "dualext-"));

    try {
      await run(cwd, makeDualExtensionTestGuard(cwd));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  test("vetoes creating a .test.tsx when the .test.ts twin exists on disk", async () => {
    await withCwd(async (cwd, guard) => {
      const dir = join(cwd, "src/features/x");

      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "X.mutations.test.ts"), "//ts");

      const veto = guard(
        "src/features/x/X.mutations.test.tsx",
        "", // empty before → a create
        "test content"
      );

      expect(veto?.reason).toBe("dual-extension-test");
      expect(veto?.message).toContain("X.mutations.test.ts");
    });
  });

  test("vetoes the reverse too — creating a .test.ts when the .test.tsx twin exists", async () => {
    await withCwd(async (cwd, guard) => {
      const dir = join(cwd, "src/features/x");

      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "X.hooks.test.tsx"), "//tsx");

      const veto = guard("src/features/x/X.hooks.test.ts", "", "content");

      expect(veto?.reason).toBe("dual-extension-test");
    });
  });

  test("allows a LONE test create (no twin on disk)", async () => {
    await withCwd(async (cwd, guard) => {
      await mkdir(join(cwd, "src/features/x"), { recursive: true });

      expect(guard("src/features/x/X.page.test.tsx", "", "content")).toBeNull();
    });
  });

  test("allows an EDIT (non-empty before) even when the twin exists — only creates block", async () => {
    await withCwd(async (cwd, guard) => {
      const dir = join(cwd, "src/features/x");

      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "X.mutations.test.ts"), "//ts");

      // Editing the .tsx (before is non-empty) is not the create that forms the pair.
      expect(
        guard(
          "src/features/x/X.mutations.test.tsx",
          "existing content",
          "new content"
        )
      ).toBeNull();
    });
  });

  test("ignores non-test files entirely", async () => {
    await withCwd(async (cwd, guard) => {
      const dir = join(cwd, "src/features/x");

      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "Widget.ts"), "//logic");

      expect(guard("src/features/x/Widget.tsx", "", "component")).toBeNull();
    });
  });
});

describe("composeGuards", () => {
  const veto: EditGuard = () => ({ reason: "a", message: "blocked by A" });
  const accept: EditGuard = () => null;

  test("returns the FIRST veto and short-circuits", () => {
    expect(composeGuards(accept, veto, accept)("f", "", "x")?.reason).toBe("a");
  });

  test("returns null when every guard accepts", () => {
    expect(composeGuards(accept, accept)("f", "", "x")).toBeNull();
  });
});

/** A provider that emits ONE `create` of the shadowed `.test.tsx`, then reports done. */
function scriptedCreateProvider(file: string): IProvider {
  let turn = 0;

  return {
    async complete() {
      turn += 1;

      if (turn === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "1",
              name: "create",
              arguments: { file, content: "// duplicate test\n" },
            },
          ],
        };
      }

      return { content: "done", toolCalls: [] };
    },
  };
}

// The reviewer's concern: the guard must actually reach the CREATE tool path and
// revert the just-written file — not merely be correct as a pure function. This
// drives a real Session whose model creates the shadowing `.test.tsx`, and asserts
// it never lands on disk.
describe("dual-extension guard through the real create tool", () => {
  const twin = "apps/ui/src/features/x/X.mutations.test.ts";
  const shadow = "apps/ui/src/features/x/X.mutations.test.tsx";

  test("a Session wired with the guard reverts the shadowing .test.tsx create", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-dualext-"));

    await Bun.write(join(dir, twin), "// existing unit tests\n");

    try {
      const session = await Session.create({
        provider: scriptedCreateProvider(shadow),
        cwd: dir,
        files: ["**/*"],
        editGuard: makeDualExtensionTestGuard(dir),
      });

      await session.send("add a duplicate .tsx test");

      // The guard fired through the real create path and reverted the write.
      expect(existsSync(join(dir, shadow))).toBe(false);
      // The pre-existing twin is untouched.
      expect(existsSync(join(dir, twin))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("without the guard the same .test.tsx create IS written (guard is the cause)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-dualext-"));

    await Bun.write(join(dir, twin), "// existing unit tests\n");

    try {
      const session = await Session.create({
        provider: scriptedCreateProvider(shadow),
        cwd: dir,
        files: ["**/*"],
      });

      await session.send("add a duplicate .tsx test");

      // No guard → the shadow lands (control that isolates the guard's effect).
      expect(existsSync(join(dir, shadow))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The panel's finding: the COMPOSITION wired into the build (makeBoringstackBuildGuard,
// used by headless-build.ts) must be tested, so dropping EITHER sub-guard fails a test.
describe("makeBoringstackBuildGuard (composed build guard)", () => {
  test("vetoes BOTH a dual-extension .test.tsx twin AND an invalid-JSON locale edit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bs-guard-"));

    try {
      const feat = join(cwd, "apps/ui/src/features/x");

      await mkdir(feat, { recursive: true });
      await writeFile(join(feat, "X.mutations.test.ts"), "//ts");

      const guard = makeBoringstackBuildGuard(cwd);

      // (1) dual-extension guard is present: creating the shadowing .test.tsx is vetoed.
      const dualVeto = guard(
        "apps/ui/src/features/x/X.mutations.test.tsx",
        "",
        "content"
      );

      expect(dualVeto?.reason).toBe("dual-extension-test");

      // (2) i18n guard is present: an edit that leaves a locale common.json as invalid
      // JSON is vetoed. (Drop either sub-guard from the composition → one of these fails.)
      const i18nVeto = guard(
        "apps/ui/src/lib/i18n/locales/en/common.json",
        '{"features":{"x":{"title":"X"}}}',
        "not valid json"
      );

      expect(i18nVeto?.reason).toBe("i18n-invalid-json");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
