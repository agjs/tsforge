import { test, expect } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runPlanning } from "../src/loop/planning/run-planning";
import { readPlan } from "../src/loop/planning/plan-store";
import type { IProvider } from "../src/inference";
import type { IPlanningDeps } from "../src/loop/planning/run-planning";

const mockPlan = {
  product: "A bookmarking app.",
  slices: [
    {
      entity: {
        id: "Bookmark",
        desc: "a link",
        fields: [{ name: "url", type: "string" }],
        relationships: [],
        rules: [],
      },
      ui: {
        screens: ["list"],
        action: "save → list",
        shows: ["url"],
        nav: "Bookmarks",
      },
      verification: {
        mustRemainTrue: ["auth"],
        mustNotHappen: ["no url"],
        acceptanceCheck: "bun test",
      },
    },
  ],
};

function fakePlanner(): IProvider {
  return {
    complete: async () => ({
      content: JSON.stringify(mockPlan),
      toolCalls: [],
    }),
  };
}

test("runPlanning writes an approved plan when the human approves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));

  try {
    const deps: IPlanningDeps = {
      planner: fakePlanner(),
      describe: async () => ({ description: "a bookmarking app" }),
      review: async () => ({ action: "approve" as const }),
      out: () => {},
    };

    expect(await runPlanning(dir, deps)).toBe("approved");
    expect((await readPlan(dir))?.status).toBe("approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPlanning returns cancelled when the human cancels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));

  try {
    const deps: IPlanningDeps = {
      planner: fakePlanner(),
      describe: async () => ({ description: "a bookmarking app" }),
      review: async () => ({ action: "cancel" as const }),
      out: () => {},
    };

    expect(await runPlanning(dir, deps)).toBe("cancelled");
    expect(await readPlan(dir)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPlanning re-proposes on revise and approves on second review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));

  try {
    let reviewCount = 0;

    const deps: IPlanningDeps = {
      planner: fakePlanner(),
      describe: async () => ({ description: "a bookmarking app" }),
      review: async () => {
        reviewCount++;

        if (reviewCount === 1) {
          return { action: "revise" as const, note: "add user auth" };
        }

        return { action: "approve" as const };
      },
      out: () => {},
    };

    expect(await runPlanning(dir, deps)).toBe("approved");
    expect((await readPlan(dir))?.status).toBe("approved");
    expect(reviewCount).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPlanning cancels after hitting the revision cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));

  try {
    let reviewCount = 0;

    const deps: IPlanningDeps = {
      planner: fakePlanner(),
      describe: async () => ({ description: "a bookmarking app" }),
      review: async () => {
        reviewCount++;

        return { action: "revise" as const, note: "more changes" };
      },
      out: () => {},
    };

    expect(await runPlanning(dir, deps)).toBe("cancelled");
    expect(await readPlan(dir)).toBeNull();
    expect(reviewCount).toBeLessThanOrEqual(5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPlanning cancels when proposePlan returns null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));

  try {
    const nullPlanner: IProvider = {
      complete: async () => ({ content: "not json", toolCalls: [] }),
    };

    const messages: string[] = [];

    const deps: IPlanningDeps = {
      planner: nullPlanner,
      describe: async () => ({ description: "a bookmarking app" }),
      review: async () => ({ action: "cancel" as const }),
      out: (s: string) => {
        messages.push(s);
      },
    };

    expect(await runPlanning(dir, deps)).toBe("cancelled");
    expect(messages.length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPlanning forwards constraints (guidance) to the planner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));

  try {
    let system = "";
    const capturingPlanner: IProvider = {
      complete: async (msgs) => {
        system = msgs.find((m) => m.role === "system")?.content ?? "";

        return { content: JSON.stringify(mockPlan), toolCalls: [] };
      },
    };

    const deps: IPlanningDeps = {
      planner: capturingPlanner,
      constraints: { guidance: "STACK-MARKER-XYZ" },
      describe: async () => ({ description: "a bookmarking app" }),
      review: async () => ({ action: "approve" as const }),
      out: () => {},
    };

    expect(await runPlanning(dir, deps)).toBe("approved");
    // The passthrough is real: the constraint's guidance reached the planner.
    expect(system).toContain("STACK-MARKER-XYZ");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPlanning forwards reservedEntities + onStripped (a reserved slice is dropped AND surfaced)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-"));

  try {
    // Planner returns a reserved "User" slice plus the real Bookmark slice.
    const planner: IProvider = {
      complete: async () => ({
        content: JSON.stringify({
          product: "p",
          slices: [
            {
              entity: {
                id: "User",
                desc: "auth",
                fields: [{ name: "email", type: "string" }],
                relationships: [],
                rules: [],
              },
              ui: {
                screens: ["form"],
                action: "log in",
                shows: ["email"],
                nav: "User",
              },
              verification: {
                mustRemainTrue: ["auth"],
                mustNotHappen: ["x"],
                acceptanceCheck: "bun test",
              },
            },
            ...mockPlan.slices,
          ],
        }),
        toolCalls: [],
      }),
    };

    const dropped: string[][] = [];
    const deps: IPlanningDeps = {
      planner,
      constraints: {
        reservedEntities: new Set(["user"]),
        onStripped: (ids) => dropped.push([...ids]),
      },
      describe: async () => ({ description: "bookmarks" }),
      review: async () => ({ action: "approve" as const }),
      out: () => {},
    };

    expect(await runPlanning(dir, deps)).toBe("approved");
    // The reserved slice was dropped from the written plan…
    const written = await readPlan(dir);

    expect(written?.plan.slices.map((s) => s.entity.id)).toEqual(["Bookmark"]);
    // …AND the drop was surfaced through the reporter (never silent).
    expect(dropped).toEqual([["User"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
