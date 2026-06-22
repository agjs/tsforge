import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import {
  parsePlan,
  planFeatures,
  parseFeatureVerdict,
  judgeFeature,
  prepareState,
  loadState,
  greenfieldDir,
  saveState,
} from "../src/loop/greenfield";
import type { IPlan } from "../src/loop/greenfield";

function providerSaying(content: string): IProvider {
  return {
    async complete() {
      return { content, toolCalls: [] };
    },
  };
}

describe("planner: parsePlan / planFeatures", () => {
  const GOOD = JSON.stringify({
    spec: "# Build it\n- sprint 1",
    features: [
      { id: "list-todos", desc: "show the todo list" },
      { id: "add-todo", desc: "add a todo", steps: [{ click: "#add" }] },
      { desc: "no id — dropped" },
    ],
  });

  test("parses spec + features and drops malformed entries", () => {
    const plan = parsePlan(GOOD);

    expect(plan?.spec).toContain("Build it");
    expect(plan?.features.map((f) => f.id)).toEqual(["list-todos", "add-todo"]);
    expect(plan?.features.every((f) => !f.passes && f.attempts === 0)).toBe(true);
    expect(plan?.features[1]?.steps).toHaveLength(1);
  });

  test("returns null when there are no usable features", () => {
    expect(parsePlan("not json")).toBeNull();
    expect(parsePlan(JSON.stringify({ spec: "x", features: [] }))).toBeNull();
    expect(parsePlan(JSON.stringify({ spec: "x" }))).toBeNull();
  });

  test("planFeatures tolerates a fenced JSON block", async () => {
    const plan = await planFeatures(
      providerSaying("```json\n" + GOOD + "\n```"),
      "build a todo app"
    );

    expect(plan?.features[0]?.id).toBe("list-todos");
  });
});

describe("feature judge: reject-by-default", () => {
  test("pass:true → ok", () => {
    const v = parseFeatureVerdict('{"pass":true,"notes":"complete"}');

    expect(v.ok).toBe(true);
    expect(v.notes).toBe("complete");
  });

  test("pass:false, missing, and unparseable all → reject (fail closed)", () => {
    expect(parseFeatureVerdict('{"pass":false,"notes":"stub"}').ok).toBe(false);
    expect(parseFeatureVerdict('{"notes":"no verdict"}').ok).toBe(false);
    expect(parseFeatureVerdict("garbage").ok).toBe(false);
    expect(parseFeatureVerdict("garbage").notes.toLowerCase()).toContain(
      "unparseable"
    );
  });

  test("judgeFeature drives through the provider", async () => {
    const v = await judgeFeature(providerSaying('{"pass":true,"notes":"ok"}'), {
      feature: "add a todo",
      code: "export const add = () => {};",
    });

    expect(v.ok).toBe(true);
  });
});

describe("prepareState: resume-first, else plan", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-prep-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const stubPlan =
    (plan: IPlan | null) =>
    async (): Promise<IPlan | null> =>
      plan;

  test("plans fresh when no state exists (writes spec.md + features.json)", async () => {
    let planCalls = 0;
    const state = await prepareState(dir, "build x", async (g) => {
      planCalls += 1;
      expect(g).toBe("build x");

      return { spec: "# spec", features: [{ id: "a", desc: "do a", passes: false, attempts: 0 }] };
    });

    expect(planCalls).toBe(1);
    expect(state?.features.map((f) => f.id)).toEqual(["a"]);
    expect(await readFile(join(greenfieldDir(dir), "spec.md"), "utf8")).toContain(
      "spec"
    );
    expect((await loadState(dir))?.goal).toBe("build x");
  });

  test("resumes existing state WITHOUT calling the planner", async () => {
    await saveState(dir, {
      goal: "old goal",
      features: [{ id: "done", desc: "d", passes: true, attempts: 1 }],
    });

    let planCalls = 0;
    const state = await prepareState(dir, "new goal", async () => {
      planCalls += 1;

      return null;
    });

    expect(planCalls).toBe(0); // resume-first: planner not consulted
    expect(state?.goal).toBe("old goal");
  });

  test("returns null when nothing exists and planning yields nothing", async () => {
    expect(await prepareState(dir, "x", stubPlan(null))).toBeNull();
  });
});
