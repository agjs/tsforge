import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveStackAdapter,
  type IStackAdapter,
} from "../src/loop/planning/stack-adapter";
import { boringstackStackAdapter } from "../src/loop/boringstack/planning";
import {
  isPhaserProject,
  phaserStackAdapter,
  PHASER_RESERVED_ENTITY_IDS,
} from "../src/loop/phaser/planning";
import { stripReservedSlices } from "../src/loop/planning/propose-plan";
import { PLANNER_EXAMPLE } from "../src/loop/phaser/plan-extension";
import { readScaffoldArchetype } from "../src/scaffold/receipt";

async function withReceipt(
  archetype: string,
  body: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-phaser-"));

  try {
    await mkdir(join(dir, ".tsforge"), { recursive: true });
    await writeFile(
      join(dir, ".tsforge", "scaffold.json"),
      JSON.stringify({ archetype })
    );
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("readScaffoldArchetype", () => {
  test("returns null when the receipt is missing", async () => {
    expect(await readScaffoldArchetype("/definitely/not/a/project")).toBeNull();
  });

  test("reads the archetype string", async () => {
    await withReceipt("phaser", async (dir) => {
      expect(await readScaffoldArchetype(dir)).toBe("phaser");
    });
  });
});

describe("phaserStackAdapter", () => {
  test("is a well-formed IStackAdapter with the phaser id and conventions", () => {
    const adapter: IStackAdapter = phaserStackAdapter;

    expect(adapter.id).toBe("phaser");
    expect(adapter.conventions).toBeDefined();
    expect(adapter.conventions?.topics()).toContain("domain-purity");
    expect(typeof adapter.contextBrief).toBe("function");
  });

  test("detect is true only for a phaser scaffold receipt", async () => {
    expect(await phaserStackAdapter.detect("/definitely/not/a/project")).toBe(
      false
    );

    await withReceipt("phaser", async (dir) => {
      expect(await isPhaserProject(dir)).toBe(true);
      expect(await phaserStackAdapter.detect(dir)).toBe(true);
      expect(await boringstackStackAdapter.detect(dir)).toBe(false);
    });

    await withReceipt("boringstack", async (dir) => {
      expect(await phaserStackAdapter.detect(dir)).toBe(false);
      expect(await boringstackStackAdapter.detect(dir)).toBe(true);
    });
  });

  test("resolveStackAdapter picks Phaser over BoringStack on a phaser receipt", async () => {
    await withReceipt("phaser", async (dir) => {
      const resolved = await resolveStackAdapter(dir, [
        boringstackStackAdapter,
        phaserStackAdapter,
      ]);

      expect(resolved?.id).toBe("phaser");
    });
  });

  test("planConstraints strips starter entities and surfaces drops", () => {
    const dropped: string[][] = [];
    const constraints = phaserStackAdapter.planConstraints((ids) =>
      dropped.push([...ids])
    );

    expect(constraints.reservedEntities?.has("player")).toBe(true);
    expect(PHASER_RESERVED_ENTITY_IDS.has("world")).toBe(true);

    const stripped = stripReservedSlices(
      PLANNER_EXAMPLE,
      PHASER_RESERVED_ENTITY_IDS
    );

    expect(stripped.slices.map((s) => s.entity.id)).toEqual([
      "Flap",
      "Pipes",
      "Crash",
      "Score",
    ]);

    const playerPlan = {
      product: "x",
      slices: [
        {
          entity: {
            id: "Player",
            desc: "the avatar",
            fields: [{ name: "x", type: "number" }],
            relationships: [],
            rules: [],
          },
          ui: {
            kind: "feature" as const,
            scene: "World",
            feature: "player",
          },
          verification: {
            mustRemainTrue: ["a"],
            mustNotHappen: ["b"],
            acceptanceCheck: "bun test",
          },
        },
      ],
    };
    const after = stripReservedSlices(
      playerPlan,
      constraints.reservedEntities ?? new Set()
    );

    expect(after.slices).toEqual([]);
    constraints.onStripped?.(["player"]);
    expect(dropped).toEqual([["player"]]);
  });
});
