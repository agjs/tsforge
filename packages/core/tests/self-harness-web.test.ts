/**
 * Web-task evaluation: split validation for the `web:` namespace and the
 * blame-allocation logic of runWebTaskOnce (pass / fail-healthy / errored-sick
 * / timeout), driven against a STUB headless-build subprocess so no model or
 * real web gate is involved.
 */
import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSplits } from "../src/self-harness/split";
import { runWebTaskOnce } from "../src/self-harness/evaluate-web";

const CORPUS = join(import.meta.dir, "..", "..", "..", "evals", "corpus");

describe("resolveSplits — web: namespace", () => {
  test("accepts web:<slug> ids only when the slug is in the provided catalog", async () => {
    const splits = await resolveSplits(
      CORPUS,
      ["math", "web:saas-crm"],
      ["slugify", "web:udemy"],
      ["saas-crm", "udemy"]
    );

    expect(splits.heldIn).toEqual(["math", "web:saas-crm"]);
    expect(splits.heldOut).toEqual(["slugify", "web:udemy"]);
  });

  test("rejects unknown web slugs, and any web id when no catalog is provided", async () => {
    await expect(
      resolveSplits(CORPUS, ["web:not-an-app"], ["math"], ["saas-crm"])
    ).rejects.toThrow(/unknown web task/);
    await expect(
      resolveSplits(CORPUS, ["web:saas-crm"], ["math"])
    ).rejects.toThrow(/unknown web task/);
  });

  test("web ids participate in the disjointness check", async () => {
    await expect(
      resolveSplits(CORPUS, ["web:udemy"], ["web:udemy"], ["udemy"])
    ).rejects.toThrow(/disjoint/);
  });
});

/** A real (but instant, model-free) subprocess: an UNKNOWN app slug makes
 *  headless-build print its catalog and exit 2 immediately — the deterministic
 *  fail path, exercising the genuine spawn + blame-allocation contract. */
async function inTmpDir(
  body: (runDir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sh-web-"));

  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runWebTaskOnce — blame allocation (real spawn, instant exit)", () => {
  test("a failing build with a HEALTHY endpoint records a minable failure", async () => {
    await inTmpDir(async (runDir) => {
      const outcome = await runWebTaskOnce("definitely-not-an-app", runDir, {
        runsDir: runDir,
        repeats: 1,
        probeHealthy: () => Promise.resolve(true),
      });

      expect(outcome.errored).toBe(false);
      expect(outcome.record.passed).toBe(false);
      expect(outcome.record.label).toBe("web:definitely-not-an-app");
      expect(outcome.run?.passed).toBe(false);
      expect(outcome.run?.slowThreshold).toBeGreaterThan(50);
    });
  });

  test("the same failure with a SICK endpoint records an errored run — no verdict", async () => {
    await inTmpDir(async (runDir) => {
      const outcome = await runWebTaskOnce("definitely-not-an-app", runDir, {
        runsDir: runDir,
        repeats: 1,
        probeHealthy: () => Promise.resolve(false),
      });

      expect(outcome.errored).toBe(true);
      expect(outcome.record.passed).toBe(false);
      expect(outcome.run).toBeUndefined();
    });
  });
});
