import { test, expect, describe } from "bun:test";
import {
  doPresentPlan,
  presentPlanArgsToRaw,
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
});
