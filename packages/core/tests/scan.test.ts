import { describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recommendConventions, scanRepo } from "../src/infer-rules/scan";

interface IFixtureFile {
  path: string;
  content: string;
}

async function withRepo<T>(
  files: IFixtureFile[],
  fn: (cwd: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tsforge-scan-"));

  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fix" }));

    for (const f of files) {
      const abs = join(dir, f.path);

      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, f.content);
    }

    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("interface naming scan + recommendation", () => {
  test("a bare-PascalCase repo recommends bare-pascal-case", async () => {
    const files: IFixtureFile[] = [
      { path: "src/a.ts", content: "export interface User { id: string; }" },
      { path: "src/b.ts", content: "export interface Order { n: number; }" },
      { path: "src/c.ts", content: "export interface Invoice { n: number; }" },
    ];

    await withRepo(files, async (cwd) => {
      const report = await scanRepo(cwd);

      expect(report.interfaces.bare).toBe(3);
      expect(report.interfaces.iPrefixed).toBe(0);
      expect(recommendConventions(report).interfaces).toBe("bare-pascal-case");
    });
  });

  test("an I-prefixed repo recommends i-prefix; Register is exempt", async () => {
    const files: IFixtureFile[] = [
      { path: "src/a.ts", content: "export interface IUser { id: string; }" },
      { path: "src/b.ts", content: "export interface IOrder { n: number; }" },
      { path: "src/reg.ts", content: "interface Register { x: number; }" },
    ];

    await withRepo(files, async (cwd) => {
      const report = await scanRepo(cwd);

      expect(report.interfaces.iPrefixed).toBe(2);
      expect(report.interfaces.total).toBe(2); // Register excluded
      expect(recommendConventions(report).interfaces).toBe("i-prefix");
    });
  });

  test("a split repo recommends off (contested)", async () => {
    const files: IFixtureFile[] = [
      { path: "src/a.ts", content: "export interface IUser { id: string; }" },
      { path: "src/b.ts", content: "export interface Order { n: number; }" },
    ];

    await withRepo(files, async (cwd) => {
      const report = await scanRepo(cwd);

      expect(recommendConventions(report).interfaces).toBe("off");
    });
  });

  test("empty repo recommends the house default i-prefix", async () => {
    await withRepo([], async (cwd) => {
      const report = await scanRepo(cwd);

      expect(report.interfaces.total).toBe(0);
      expect(recommendConventions(report).interfaces).toBe("i-prefix");
    });
  });
});

describe("enum scan", () => {
  test("enums present → recommend allow; absent → ban", async () => {
    await withRepo(
      [{ path: "src/e.ts", content: "export enum Color { Red, Blue }" }],
      async (cwd) => {
        const report = await scanRepo(cwd);

        expect(report.enums.fileCount).toBe(1);
        expect(recommendConventions(report).enums).toBe("allow");
      }
    );

    await withRepo(
      [{ path: "src/x.ts", content: "export const x = 1;" }],
      async (cwd) => {
        expect(recommendConventions(await scanRepo(cwd)).enums).toBe("ban");
      }
    );
  });
});

describe("test layout scan", () => {
  test("co-located dominant → co-located", async () => {
    const files: IFixtureFile[] = [
      { path: "src/a.ts", content: "export const a = 1;" },
      { path: "src/a.test.ts", content: "test('a', () => {});" },
      { path: "src/b.test.ts", content: "test('b', () => {});" },
    ];

    await withRepo(files, async (cwd) => {
      const report = await scanRepo(cwd);

      expect(report.tests.coLocated).toBe(2);
      expect(recommendConventions(report).tests).toBe("co-located");
    });
  });

  test("mirrored tests/ dir → mirrored", async () => {
    const files: IFixtureFile[] = [
      { path: "src/a.ts", content: "export const a = 1;" },
      { path: "tests/a.test.ts", content: "test('a', () => {});" },
      { path: "tests/b.test.ts", content: "test('b', () => {});" },
    ];

    await withRepo(files, async (cwd) => {
      const report = await scanRepo(cwd);

      expect(report.tests.mirrored).toBe(2);
      expect(recommendConventions(report).tests).toBe("mirrored");
    });
  });
});

describe("folder + tooling scan", () => {
  test("src/views → tsforge-views; tooling presence detected", async () => {
    const files: IFixtureFile[] = [
      { path: "src/views/Dashboard/index.tsx", content: "export const x = 1;" },
      { path: "tsconfig.json", content: "{}" },
    ];

    await withRepo(files, async (cwd) => {
      const report = await scanRepo(cwd);

      expect(report.folders.views).toBe(true);
      expect(report.tooling.tsconfig).toBe(true);
      expect(recommendConventions(report).componentFolders).toBe(
        "tsforge-views"
      );
    });
  });

  test("repo-own layout (src/features) → repo", async () => {
    const files: IFixtureFile[] = [
      { path: "src/features/auth/login.ts", content: "export const x = 1;" },
    ];

    await withRepo(files, async (cwd) => {
      const report = await scanRepo(cwd);

      expect(report.folders.features).toBe(true);
      expect(recommendConventions(report).componentFolders).toBe("repo");
    });
  });
});

describe("scan resilience", () => {
  test("an unreadable file mid-scan does not crash the scan", async () => {
    const files: IFixtureFile[] = [
      { path: "src/ok.ts", content: "export interface User { id: string; }" },
      {
        path: "src/locked.ts",
        content: "export interface Order { n: number; }",
      },
    ];

    await withRepo(files, async (cwd) => {
      chmodSync(join(cwd, "src/locked.ts"), 0o000);

      try {
        // Must resolve (not reject) even if a file errors on read; the readable
        // file is still tallied.
        const report = await scanRepo(cwd);

        expect(report.interfaces.total).toBeGreaterThanOrEqual(1);
      } finally {
        chmodSync(join(cwd, "src/locked.ts"), 0o644);
      }
    });
  });
});
