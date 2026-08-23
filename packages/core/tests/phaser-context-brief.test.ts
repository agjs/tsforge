import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapterSessionExtras,
  resolveStackAdapter,
} from "../src/loop/planning/stack-adapter";
import { phaserStackAdapter } from "../src/loop/phaser/planning";
import { boringstackStackAdapter } from "../src/loop/boringstack/planning";
import {
  PHASER_CATALOG_CAP,
  PHASER_STATIC_BRIEF,
  phaserContextBrief,
  type IPhaserBriefIo,
} from "../src/loop/phaser/context-brief";

const DECOY_BODY = "SECRET_DECOY_SHOULD_NEVER_APPEAR";

async function withReceipt(
  body: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-phaser-brief-"));

  try {
    await mkdir(join(dir, ".tsforge"), { recursive: true });
    await writeFile(
      join(dir, ".tsforge", "scaffold.json"),
      JSON.stringify({ archetype: "phaser" })
    );
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("phaserContextBrief", () => {
  test("includes the static map and does not walk decoy source", async () => {
    const reads: string[] = [];
    const lists: string[] = [];
    const io: IPhaserBriefIo = {
      readText: (path) => {
        reads.push(path);

        if (path.includes("secret") || path.endsWith(".ts")) {
          throw new Error(`must not read ${path}`);
        }

        if (path.replaceAll("\\", "/").endsWith("docs/ai/catalog.md")) {
          return Promise.resolve(
            "# Codebase Catalog\n\n| Module | Path |\n| coin | src/domain/coin |\n"
          );
        }

        throw new Error(`unexpected read ${path}`);
      },
      listNames: (dir) => {
        lists.push(dir);

        return Promise.resolve(["should-not-list-when-catalog-exists"]);
      },
    };

    const brief = await phaserContextBrief("/tmp/game", io);

    expect(brief).toContain("DO NOT ORIENT BY WALKING THE TREE");
    expect(brief).toContain("gameConfig.ts");
    expect(brief).toContain("WorldScene.setup.ts");
    expect(brief).toContain("composeRuntime.ts");
    expect(brief).toContain("bun run new:feature");
    expect(brief).toContain("src/domain/coin");
    expect(brief).not.toContain(DECOY_BODY);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.replaceAll("\\", "/")).toContain("docs/ai/catalog.md");
    expect(lists).toEqual([]);
  });

  test("falls back to directory names when catalog.md is missing", async () => {
    const io: IPhaserBriefIo = {
      readText: () => Promise.reject(new Error("ENOENT")),
      listNames: (dir) => {
        const norm = dir.replaceAll("\\", "/");

        if (norm.endsWith("src/domain")) {
          return Promise.resolve(["player", "grid"]);
        }

        if (norm.endsWith("src/features")) {
          return Promise.resolve(["movement"]);
        }

        if (norm.endsWith("scenes")) {
          return Promise.resolve(["BootScene", "WorldScene"]);
        }

        return Promise.resolve([]);
      },
    };

    const brief = await phaserContextBrief("/tmp/game", io);

    expect(brief).toContain("src/domain: player, grid");
    expect(brief).toContain("WorldScene");
    expect(brief.startsWith(PHASER_STATIC_BRIEF.slice(0, 20))).toBe(true);
  });

  test("missing catalog and missing src dirs still returns the static map", async () => {
    const io: IPhaserBriefIo = {
      readText: () => Promise.reject(new Error("ENOENT")),
      listNames: () => Promise.resolve([]),
    };

    const brief = await phaserContextBrief("/no/such/dir", io);

    expect(brief.length).toBeGreaterThan(0);
    expect(brief).toContain("PHASER HARNESS");
    expect(brief).toContain("(none)");
  });

  test("caps a huge catalog", async () => {
    const huge = `${"x".repeat(PHASER_CATALOG_CAP + 80)}\nTAIL`;
    const io: IPhaserBriefIo = {
      readText: () => Promise.resolve(huge),
      listNames: () => Promise.resolve([]),
    };

    const brief = await phaserContextBrief("/tmp/game", io);

    expect(brief).toContain("[catalog truncated]");
    expect(brief).not.toContain("TAIL");
  });
});

describe("adapterSessionExtras — Phaser", () => {
  test("injects guidance from contextBrief on a phaser receipt", async () => {
    await withReceipt(async (dir) => {
      await mkdir(join(dir, "docs", "ai"), { recursive: true });
      await mkdir(join(dir, "src", "secret"), { recursive: true });
      await writeFile(
        join(dir, "docs", "ai", "catalog.md"),
        "# Codebase Catalog\n\ncoin module\n"
      );
      await writeFile(join(dir, "src", "secret", "do-not-read.ts"), DECOY_BODY);

      const extras = await adapterSessionExtras(dir, [
        boringstackStackAdapter,
        phaserStackAdapter,
      ]);

      expect(extras.pullConventions).toBe(true);
      expect(extras.conventions).toBeDefined();
      expect(extras.guidance).toContain("DO NOT ORIENT");
      expect(extras.guidance).toContain("coin module");
      expect(extras.guidance).not.toContain(DECOY_BODY);

      const resolved = await resolveStackAdapter(dir, [
        boringstackStackAdapter,
        phaserStackAdapter,
      ]);

      expect(resolved?.contextBrief !== undefined).toBe(true);
    });
  });

  test("returns empty extras when no adapter matches", async () => {
    const extras = await adapterSessionExtras("/definitely/not/a/project", [
      boringstackStackAdapter,
      phaserStackAdapter,
    ]);

    expect(extras).toEqual({});
  });
});
