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
