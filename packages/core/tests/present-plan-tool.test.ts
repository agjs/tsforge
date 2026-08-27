import { test, expect, describe } from "bun:test";
import {
  doPresentPlan,
  presentPlanArgsToRaw,
  presentPlanMessage,
  shouldPauseForPresentPlan,
  PRESENT_PLAN_SENTINEL,
} from "../src/loop/tools/present-plan-tool";
import type { IToolContext } from "../src/loop/tools/tool-context";
import type { IPlanDocument } from "../src/loop/worklist/checklist.types";

function ctx(onPlanPresented?: (plan: IPlanDocument) => void): IToolContext {
  return {
    cwd: "/tmp",
    files: ["**/*"],
    task: "session",
    report: () => undefined,
    ...(onPlanPresented === undefined ? {} : { onPlanPresented }),
  };
}

describe("presentPlanArgsToRaw", () => {
  test("accepts top-level goal + items", () => {
    expect(
      presentPlanArgsToRaw({
        goal: "g",
        items: [{ title: "A" }],
      })
    ).toEqual({ goal: "g", items: [{ title: "A" }] });
  });

  test("accepts nested plan object", () => {
    expect(
      presentPlanArgsToRaw({
        plan: { goal: "g", items: [{ title: "A" }] },
      })
    ).toEqual({ goal: "g", items: [{ title: "A" }] });
  });
});

describe("doPresentPlan", () => {
  test("validates, notifies, does not invent done", () => {
    const presented: IPlanDocument[] = [];
    const result = doPresentPlan(
      {
        goal: "ship rail",
        items: [
          {
            title: "Parent",
            children: [{ title: "Child", verify: "bun test" }],
          },
        ],
      },
      ctx((p) => {
        presented.push(p);
      })
    );

    expect(result).toMatch(/presented/i);
    expect(result).toMatch(/Do NOT paste/i);
    expect(presented).toHaveLength(1);
    expect(presented[0]?.goal).toBe("ship rail");
    expect(presented[0]?.items[0]?.children?.[0]?.verify).toBe("bun test");
    expect(presented[0]?.items[0]?.status).toBe("pending");
  });

  test("rejects empty items", () => {
    const result = doPresentPlan({ goal: "x", items: [] }, ctx());

    expect(result).toMatch(/invalid|empty|items/i);
  });

  test("appends decomposition advice without rejecting", () => {
    const presented: IPlanDocument[] = [];
    const result = doPresentPlan(
      {
        goal: "ship and polish",
        items: [
          {
            title: "Run the gate",
            files: ["a.ts", "b.ts", "c.ts", "d.ts"],
          },
        ],
      },
      ctx((p) => {
        presented.push(p);
      })
    );

    expect(presented).toHaveLength(1);
    expect(result).toMatch(/presented/i);
    expect(result).toMatch(/Decomposition advice/i);
    expect(result).toMatch(/gate chore/i);
    expect(result).toMatch(/single top-level item/i);
  });

  test("persists advisory kind through present_plan", () => {
    const presented: IPlanDocument[] = [];

    doPresentPlan(
      {
        goal: "notes",
        items: [{ title: "Create src/notes.ts", kind: "create" }],
      },
      ctx((p) => {
        presented.push(p);
      })
    );

    expect(presented[0]?.items[0]?.kind).toBe("create");
  });
});

describe("present_plan pause sentinel", () => {
  test("a VALID proposal carries the pause sentinel; the model-facing text is clean", () => {
    // The send must END on a validated proposal — real models otherwise keep
    // exploring and the human's "approve" is swallowed as mid-send steering.
    const result = doPresentPlan({ goal: "g", items: [{ title: "A" }] }, ctx());

    expect(result.startsWith(PRESENT_PLAN_SENTINEL)).toBe(true);
    expect(shouldPauseForPresentPlan("present_plan", result)).toBe(true);
    // The sentinel never reaches the model.
    expect(presentPlanMessage(result)).not.toContain(PRESENT_PLAN_SENTINEL);
    expect(presentPlanMessage(result)).toMatch(/presented/i);
  });

  test("a REJECTED proposal returns plain text — the model revises in the same send", () => {
    const result = doPresentPlan({ goal: "x", items: [] }, ctx());

    expect(result.startsWith(PRESENT_PLAN_SENTINEL)).toBe(false);
    expect(shouldPauseForPresentPlan("present_plan", result)).toBe(false);
  });

  test("another tool cannot forge the boundary — gated on the call name", () => {
    expect(
      shouldPauseForPresentPlan("run", `${PRESENT_PLAN_SENTINEL}whatever`)
    ).toBe(false);
  });
});
