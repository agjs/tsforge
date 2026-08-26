import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveScaffoldedWorkspace,
  type IScaffoldWorkspaceIo,
} from "../src/scaffold/receipt";
import { adapterSessionExtras } from "../src/loop/planning/stack-adapter";
import { phaserStackAdapter } from "../src/loop/phaser/planning";
import { boringstackStackAdapter } from "../src/loop/boringstack/planning";

function io(opts: {
  readonly receipts: Readonly<Record<string, string>>;
  readonly dirs: Readonly<Record<string, readonly string[]>>;
  readonly packages: readonly string[];
}): IScaffoldWorkspaceIo {
  const pkg = new Set(opts.packages);

  return {
    read: (path) => {
      const body = opts.receipts[path];

      if (body === undefined) {
        return Promise.reject(new Error("ENOENT"));
      }

      return Promise.resolve(body);
    },
    listDirs: (path) => Promise.resolve(opts.dirs[path] ?? []),
    hasPackageJson: (path) => Promise.resolve(pkg.has(path)),
  };
}

const PARENT = "/tmp/parent";
const CHILD = join(PARENT, "testing-project");
const PHASER = JSON.stringify({ archetype: "phaser" });

describe("resolveScaffoldedWorkspace", () => {
  test("returns dir when it has a receipt", async () => {
    const resolved = await resolveScaffoldedWorkspace(
      CHILD,
      io({
        receipts: { [join(CHILD, ".tsforge", "scaffold.json")]: PHASER },
        dirs: {},
        packages: [CHILD],
      })
    );

    expect(resolved).toBe(CHILD);
  });

  test("enters the single scaffolded child when the parent has no package.json", async () => {
    const resolved = await resolveScaffoldedWorkspace(
      PARENT,
      io({
        receipts: { [join(CHILD, ".tsforge", "scaffold.json")]: PHASER },
        dirs: { [PARENT]: ["testing-project"] },
        packages: [],
      })
    );

    expect(resolved).toBe(CHILD);
  });

  test("does not guess when the parent is itself a package", async () => {
    const resolved = await resolveScaffoldedWorkspace(
      PARENT,
      io({
        receipts: { [join(CHILD, ".tsforge", "scaffold.json")]: PHASER },
        dirs: { [PARENT]: ["testing-project"] },
        packages: [PARENT],
      })
    );

    expect(resolved).toBe(PARENT);
  });

  test("does not guess when two children have receipts", async () => {
    const other = join(PARENT, "other-game");
    const resolved = await resolveScaffoldedWorkspace(
      PARENT,
      io({
        receipts: {
          [join(CHILD, ".tsforge", "scaffold.json")]: PHASER,
          [join(other, ".tsforge", "scaffold.json")]: PHASER,
        },
        dirs: { [PARENT]: ["testing-project", "other-game"] },
        packages: [],
      })
    );

    expect(resolved).toBe(PARENT);
  });

  test("a parent of one Phaser child yields Phaser session extras", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tsforge-parent-"));
    const child = join(parent, "testing-project");

    try {
      await mkdir(join(child, ".tsforge"), { recursive: true });
      await writeFile(
        join(child, ".tsforge", "scaffold.json"),
        JSON.stringify({ archetype: "phaser" })
      );

      const resolved = await resolveScaffoldedWorkspace(parent);
      const extras = await adapterSessionExtras(resolved, [
        boringstackStackAdapter,
        phaserStackAdapter,
      ]);

      expect(resolved).toBe(child);
      expect(extras.guidance).toContain("PHASER HARNESS");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
