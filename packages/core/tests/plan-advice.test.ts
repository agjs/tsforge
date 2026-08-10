import { test, expect, describe } from "bun:test";
import {
  advisePlanDecomposition,
  isLayerShapedTitle,
} from "../src/loop/worklist/plan-advice";
import type { IPlanDocument } from "../src/loop/worklist/checklist.types";

function plan(
  items: IPlanDocument["items"],
  goal = "Build notes CLI with add and list"
): IPlanDocument {
  return {
    schemaVersion: 2,
    id: "p1",
    goal,
    activeItemId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    items,
  };
}

describe("isLayerShapedTitle", () => {
  test("flags horizontal layer titles", () => {
    expect(isLayerShapedTitle("Define types")).toBe(true);
    expect(isLayerShapedTitle("Add mocks")).toBe(true);
    expect(isLayerShapedTitle("Wire API layer")).toBe(true);
    expect(isLayerShapedTitle("Create hooks")).toBe(true);
  });

  test("vertical feature titles are not layers", () => {
    expect(isLayerShapedTitle("Feed page end-to-end")).toBe(false);
    expect(isLayerShapedTitle("Clan detail")).toBe(false);
    expect(isLayerShapedTitle("Scaffold + one visible card")).toBe(false);
    expect(isLayerShapedTitle("Add gamer form")).toBe(false);
  });
});

describe("advisePlanDecomposition", () => {
  test("quiet when items are vertical and concrete", () => {
    expect(
      advisePlanDecomposition(
        plan(
          [
            {
              id: "a",
              title: "Feed page end-to-end",
              status: "pending",
              files: [
                "src/data/seed.ts",
                "src/mocks/handlers.ts",
                "src/api/clans.ts",
                "src/hooks/use-clans.ts",
                "src/views/Feed/index.tsx",
                "src/views/Feed/components/ClanCard.tsx",
              ],
              kind: "create",
              children: [
                {
                  id: "a1",
                  title: "Create src/api/clans.test.ts",
                  status: "pending",
                  kind: "test",
                  files: ["src/api/clans.test.ts"],
                },
              ],
            },
          ],
          "Build Clanboard"
        )
      )
    ).toEqual([]);
  });

  test("does not scold a vertical slice for listing more than 3 files", () => {
    const warnings = advisePlanDecomposition(
      plan(
        [
          {
            id: "a",
            title: "Feed page end-to-end",
            status: "pending",
            files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
          },
          {
            id: "b",
            title: "Detail page",
            status: "pending",
            files: ["src/views/Detail/index.tsx"],
          },
        ],
        "Build Clanboard"
      )
    );

    expect(warnings.some((w) => w.includes("files"))).toBe(false);
  });

  test("warns on gate-chore titles", () => {
    const warnings = advisePlanDecomposition(
      plan([
        {
          id: "a",
          title: "Run tests and lint",
          status: "pending",
          files: ["a.ts"],
        },
        {
          id: "b",
          title: "Wire CLI",
          status: "pending",
          files: ["src/cli.ts"],
        },
      ])
    );

    expect(warnings.some((w) => w.includes("gate chore"))).toBe(true);
  });

  test("warns on a layer-first types/mocks/api plan", () => {
    const warnings = advisePlanDecomposition(
      plan(
        [
          {
            id: "a",
            title: "Define types",
            status: "pending",
            files: ["src/types/clan.ts"],
          },
          {
            id: "b",
            title: "Add mocks",
            status: "pending",
            files: ["src/mocks/handlers.ts"],
          },
          {
            id: "c",
            title: "Wire API layer",
            status: "pending",
            files: ["src/api/clans.ts"],
          },
          {
            id: "d",
            title: "Create hooks",
            status: "pending",
            files: ["src/hooks/use-clans.ts"],
          },
        ],
        "Build Clanboard"
      )
    );

    expect(warnings.some((w) => w.includes("layer-first"))).toBe(true);
    expect(warnings.some((w) => w.includes("vertical"))).toBe(true);
  });

  test("warns on a lone mega-item for a multi-part goal", () => {
    const warnings = advisePlanDecomposition(
      plan(
        [
          {
            id: "a",
            title: "Do everything",
            status: "pending",
            files: ["src/a.ts", "src/b.ts"],
          },
        ],
        "Build notes CLI with add and list"
      )
    );

    expect(warnings.some((w) => w.includes("no children"))).toBe(true);
  });
});
