import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_STAGE_FLOOR,
  observeStageFloor,
  raiseStageFloor,
  stageFloorViolation,
} from "../src/gate/stage-floor";
import { TSC_STAGE_LABEL, TYPE_AWARE_STAGE_LABEL } from "../src/gate/core-gate";
import { resolveGate } from "../src/cli/gate-setup";
import { parseArgs } from "../src/cli";

describe("stage floor — pure semantics", () => {
  test("observe reads stages from a real gate label without string drift", () => {
    const full = observeStageFloor(
      `${TSC_STAGE_LABEL} + strict TypeScript (tsforge) + ${TYPE_AWARE_STAGE_LABEL} + tests`
    );

    expect(full.hadTsc).toBe(true);
    expect(full.hadTypeAware).toBe(true);

    const lintOnly = observeStageFloor("strict TypeScript (tsforge)");

    expect(lintOnly.hadTsc).toBe(false);
    expect(lintOnly.hadTypeAware).toBe(false);
  });

  test("raise is monotonic; violation fires only on a LOSS", () => {
    const withTsc = raiseStageFloor(
      EMPTY_STAGE_FLOOR,
      observeStageFloor(TSC_STAGE_LABEL)
    );

    // Gaining a stage is never a violation.
    expect(stageFloorViolation(EMPTY_STAGE_FLOOR, withTsc)).toBeNull();
    // Holding the floor is fine.
    expect(stageFloorViolation(withTsc, withTsc)).toBeNull();

    // Losing the tsc stage is a violation that names the stage + escape hatch.
    const lost = stageFloorViolation(
      withTsc,
      observeStageFloor("strict TypeScript (tsforge)")
    );

    expect(lost).toContain(TSC_STAGE_LABEL);
    expect(lost).toContain("--continue");
  });
});

describe("stage floor — auto-gate resolver", () => {
  test("deleting tsconfig.json + package.json mid-session reds instead of silently weakening", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-floor-"));

    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true } })
      );
      await writeFile(join(dir, "a.ts"), "export const a = 1;\n");

      const resolved = await resolveGate({ ...parseArgs([]), dir }, null);
      const resolver = resolved.autoGate;

      expect(resolver).toBeDefined();

      // Cycle 1: the gate has its tsc stage → the floor records it.
      const first = await resolver?.();

      expect(first?.command).toContain("tsc");
      expect(first?.downgrade).toBeUndefined();

      // The code under test deletes both files (the FG-2 shape: before the
      // floor, the re-resolved command silently LOST its type stage, and with
      // a child package dir present the whole gate collapsed to `true`).
      await unlink(join(dir, "tsconfig.json"));
      await unlink(join(dir, "package.json"));

      const second = await resolver?.();

      expect(second?.downgrade).toBeDefined();
      expect(second?.downgrade).toContain(TSC_STAGE_LABEL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stable project never trips the floor across cycles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-floor-ok-"));

    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true } })
      );

      const resolved = await resolveGate({ ...parseArgs([]), dir }, null);

      for (let i = 0; i < 3; i += 1) {
        expect((await resolved.autoGate?.())?.downgrade).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
