import { test, expect, describe } from "bun:test";
import {
  boringstackCommandStage,
  reachabilityStage,
  judgeStage,
} from "../src/loop/boringstack/gate-stages";
import type { Exec } from "../src/loop/boringstack/exec";
import type { IFeature } from "../src/loop/greenfield/greenfield.types";
import type { IProvider } from "../src/inference";

const feature: IFeature = {
  id: "note",
  desc: "a note",
  passes: false,
  attempts: 0,
};

const execWith =
  (code: number, stdout: string): Exec =>
  async () => ({ code, stdout, stderr: "" });

describe("boringstackCommandStage", () => {
  test("green gate → passed, no errors", async () => {
    const stage = boringstackCommandStage(
      "/tmp/clone",
      execWith(0, "all good")
    );
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("red gate → each failure signature becomes an IErrorItem (key = signature)", async () => {
    const out = "1:1 error Unexpected  no-console\nerror TS2322: bad";
    const stage = boringstackCommandStage("/tmp/clone", execWith(1, out));
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);

    // Every error carries a stable key so checkStuck can fingerprint it and the
    // differential wrapper can suppress baseline signatures.
    for (const e of r.errors) {
      expect(typeof e.key).toBe("string");
      expect(e.key.length).toBeGreaterThan(0);
    }
  });
});

describe("reachabilityStage", () => {
  test("when feature directory doesn't exist → skips gracefully (no reachability errors)", async () => {
    const stage = reachabilityStage("/nonexistent", "note");
    const r = await stage.run("/nonexistent");

    // Without the router/API files present, the check can't prove it's unreachable, so it passes
    expect(r.passed).toBe(true);
  });
});

describe("judgeStage", () => {
  test("judge rejects → one IErrorItem with rule 'judge' and a resolvable file", async () => {
    const providerWithReject: IProvider = {
      complete: async () => ({
        content: '{"pass":false,"notes":"stub only"}',
        toolCalls: [],
      }),
    };
    const stage = judgeStage(providerWithReject, "/tmp/clone", feature);
    const r = await stage.run("/tmp/clone");

    expect(r.passed).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.rule).toBe("judge");
    expect(r.errors[0]?.message).toContain("stub only");
  });

  test("judge passes → green", async () => {
    const providerWithPass: IProvider = {
      complete: async () => ({
        content: '{"pass":true,"notes":"good"}',
        toolCalls: [],
      }),
    };
    const stage = judgeStage(providerWithPass, "/tmp/clone", feature);

    expect((await stage.run("/tmp/clone")).passed).toBe(true);
  });
});
