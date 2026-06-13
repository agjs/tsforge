import { test, expect } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec } from "../src/spec";
import { runTask } from "../src/loop";
import type { ILoopEvent } from "../src/loop/loop.types";
import { analyzeEvents, buildSweepReport, type IRunRecord } from "../src/eval";
import { scripted, editStep, STOP } from "./stub-provider";

const CORPUS = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "evals",
  "corpus",
  "math"
);

// The scripted "model" edits each RED stub's function block to a correct one.
const STUB_FN: Record<string, string> = {
  "add.ts":
    "export function add(_a: number, _b: number): number {\n  return 0;\n}",
  "mul.ts":
    "export function mul(_amount: number, _qty: number): number {\n  return 0;\n}",
};

const FIXED_FN: Record<string, string> = {
  "add.ts":
    "export function add(a: number, b: number): number {\n  return a + b;\n}",
  "mul.ts":
    "export function mul(amount: number, qty: number): number {\n  return amount * qty;\n}",
};

// End-to-end proof that the eval stack runs on the COMMITTED corpus seed (real
// loop + real gate, no model): red→green per task, then the metrics library and
// the sweep report both consume the run we just produced. This is the exact path
// a live-model sweep exercises — minus the model.
test("eval pipeline: math seed runs red→green and feeds metrics + report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-eval-e2e-"));

  try {
    for (const name of await readdir(CORPUS)) {
      await Bun.write(join(dir, name), Bun.file(join(CORPUS, name)));
    }

    const spec = parseSpec(await Bun.file(join(dir, "math.spec.md")).text());
    const events: ILoopEvent[] = [];
    const records: IRunRecord[] = [];

    for (const task of spec.tasks) {
      const file = task.files[0]!;
      const provider = scripted([
        editStep(file, STUB_FN[file]!, FIXED_FN[file]!),
        STOP,
      ]);
      const result = await runTask(task, dir, provider, {
        onEvent: (e) => events.push(e),
      });

      expect(result.redConfirmed).toBe(true); // stub failed before the edit
      expect(result.status).toBe("done"); // correct impl passes the gate

      records.push({
        label: "correct temp=0",
        passed: result.status === "done",
        cycles: result.cycles,
        ms: 1,
      });
    }

    // The metrics library distills the real event stream we just produced.
    const metrics = analyzeEvents(events);

    expect(metrics.finalStatus).toBe("done");
    expect(metrics.edits).toBeGreaterThanOrEqual(2);
    expect(metrics.gateRuns).toBeGreaterThanOrEqual(2);

    // The report aggregates the run records into a pass-rate + CI.
    const report = buildSweepReport(records, "correct temp=0");
    const variant = report.variants[0]!;

    expect(variant.runs).toBe(2);
    expect(variant.passRate).toBe(1);
    expect(variant.passRateCI[1]).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
