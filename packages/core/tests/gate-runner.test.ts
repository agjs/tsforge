import { test, expect, describe } from "bun:test";
import {
  composeGate,
  differentialStage,
  type IStage,
} from "../src/gate/gate-runner";
import type { IValidateResult } from "../src/validate";

const green: IStage = {
  run: async () => ({ passed: true, errors: [], output: "ok" }),
};

const redWith = (keys: string[]): IStage => ({
  run: async (): Promise<IValidateResult> => ({
    passed: false,
    errors: keys.map((k) => ({ key: k, message: k })),
    output: keys.join("\n"),
  }),
});

describe("composeGate", () => {
  test("all stages green → passed, no errors", async () => {
    const gate = composeGate([green, green]);
    const r = await gate.run("/tmp");

    expect(r.passed).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("stops at the FIRST failing stage (short-circuit)", async () => {
    let secondRan = false;
    const spy: IStage = {
      run: async () => {
        secondRan = true;

        return {
          passed: false,
          errors: [{ key: "b", message: "b" }],
          output: "b",
        };
      },
    };
    const gate = composeGate([redWith(["a"]), spy]);
    const r = await gate.run("/tmp");

    expect(r.passed).toBe(false);
    expect(r.errors.map((e) => e.key)).toEqual(["a"]);
    expect(secondRan).toBe(false);
  });

  test("empty stage list → green", async () => {
    const r = await composeGate([]).run("/tmp");

    expect(r.passed).toBe(true);
  });
});

describe("differentialStage", () => {
  test("suppresses baseline failures, surfaces only NEW ones", async () => {
    const stage = differentialStage(
      redWith(["base1", "new1"]),
      new Set(["base1"])
    );
    const r = await stage.run("/tmp");

    expect(r.passed).toBe(false);
    expect(r.errors.map((e) => e.key)).toEqual(["new1"]);
  });

  test("all failures are baseline → passes (feature introduced nothing new)", async () => {
    const stage = differentialStage(
      redWith(["base1", "base2"]),
      new Set(["base1", "base2"])
    );
    const r = await stage.run("/tmp");

    expect(r.passed).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("inner green → passes through green", async () => {
    const stage = differentialStage(green, new Set(["base1"]));

    expect((await stage.run("/tmp")).passed).toBe(true);
  });
});
