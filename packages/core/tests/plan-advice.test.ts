import { test, expect, describe } from "bun:test";
import { advisePlanDecomposition } from "../src/loop/worklist/plan-advice";
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

describe("advisePlanDecomposition", () => {
  test("quiet when items are small and concrete", () => {
    expect(
      advisePlanDecomposition(
        plan(
          [
            {
              id: "a",
              title: "Create src/notes.ts",
              status: "pending",
              files: ["src/notes.ts"],
              kind: "create",
              children: [
                {
                  id: "a1",
                  title: "Create src/notes.test.ts",
                  status: "pending",
                  kind: "test",
                  files: ["src/notes.test.ts"],
                },
              ],
            },
          ],
          "Build notes CLI"
        )
      )
    ).toEqual([]);
  });

  test("warns on too many files and gate-chore titles", () => {
    const warnings = advisePlanDecomposition(
      plan([
        {
          id: "a",
          title: "Run tests and lint",
          status: "pending",
          files: ["a.ts", "b.ts", "c.ts", "d.ts"],
        },
        {
          id: "b",
          title: "Wire CLI",
          status: "pending",
          files: ["src/cli.ts"],
        },
      ])
    );

    expect(warnings.some((w) => w.includes("4 files"))).toBe(true);
    expect(warnings.some((w) => w.includes("gate chore"))).toBe(true);
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
