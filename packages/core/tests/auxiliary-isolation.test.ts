import { test, expect, describe } from "bun:test";
import { join } from "node:path";

const LOOP_SOURCE = join(import.meta.dir, "..", "src", "loop");

async function source(name: string): Promise<string> {
  return Bun.file(join(LOOP_SOURCE, name)).text();
}

function expectOverrideConsumedBeforeCall(
  text: string,
  readMarker: string,
  completeMarker: string
): void {
  const readAt = text.indexOf(readMarker);
  const clearAt = text.indexOf("pendingModelOverride = null", readAt);
  const completeAt = text.indexOf(completeMarker, readAt);

  expect(readAt).toBeGreaterThanOrEqual(0);
  expect(clearAt).toBeGreaterThan(readAt);
  expect(completeAt).toBeGreaterThan(clearAt);
}

describe("Auxiliary call isolation (no pendingModelOverride)", () => {
  test("each main-loop call consumes its override before calling the provider", async () => {
    const [session, run] = await Promise.all([
      source("session.ts"),
      source("run.ts"),
    ]);

    expectOverrideConsumedBeforeCall(
      session,
      "const override = this.state.pendingModelOverride",
      "this.provider.complete"
    );
    expectOverrideConsumedBeforeCall(
      run,
      "const override = args.state.pendingModelOverride",
      "args.provider.complete"
    );
  });

  test("auxiliary calls cannot read the pending main-loop override", async () => {
    const session = await source("session.ts");
    const compactStart = session.indexOf("  async compact(");
    const compactEnd = session.indexOf("  get messages", compactStart);
    const compact = session.slice(compactStart, compactEnd);
    const auxiliaryFiles = [
      "planning/propose-plan.ts",
      "greenfield/plan.ts",
      "greenfield/judge.ts",
      "expert-handoff.ts",
      "boringstack/plan-resources.ts",
      "review/review-change.ts",
    ];
    const auxiliarySources = await Promise.all(auxiliaryFiles.map(source));

    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactEnd).toBeGreaterThan(compactStart);
    expect(compact).toContain("this.provider.complete");
    expect(compact).toContain("temperature: 0");
    expect(compact).not.toContain("pendingModelOverride");

    for (const auxiliary of auxiliarySources) {
      expect(auxiliary).not.toContain("pendingModelOverride");
    }
  });
});
