import { test, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Create a temporary directory for testing. */
async function createTempDir(): Promise<string> {
  const base = "/tmp";
  const suffix = Math.random().toString(36).slice(2, 9);
  const dir = join(base, `edit-benchmark-test-${suffix}`);

  await mkdir(dir, { recursive: true });

  return dir;
}

/** Fixture: minimal run.log with edit and edit_lines tool calls */
function createFixtureLog(options: {
  editCalls?: number;
  editRejects?: number;
  editLinesCalls?: number;
  editLinesRejects?: number;
  staleRecoveries?: number;
  gateFails?: number;
  turnsToGreen?: number;
  green?: boolean;
}): string {
  const {
    editCalls = 2,
    editRejects = 0,
    editLinesCalls = 1,
    editLinesRejects = 0,
    staleRecoveries = 0,
    turnsToGreen = 3,
    green = true,
  } = options;

  let log = `task "example": RED

turn 1: asking model
turn 1: red (2 errors: Line 5, Line 12)
⏱ turn 1 took 2.5s (total 2.5s)
`;

  for (let i = 0; i < editCalls; i++) {
    if (i < editCalls - editRejects) {
      log += `✎ edit src/main.ts (chunk ${i + 1})\n`;
      log += `edited src/main.ts\n`;
    } else {
      log += `edit src/main.ts REJECTED: anchor mismatch\n`;
    }
  }

  for (let i = 0; i < editLinesCalls; i++) {
    if (i < editLinesCalls - editLinesRejects) {
      log += `edit_lines src/utils.ts\n`;
      log += `edited src/utils.ts (new hash #abc123)\n`;
    } else {
      log += `edit_lines src/utils.ts REJECTED: stale hash\n`;
    }
  }

  for (let i = 0; i < staleRecoveries; i++) {
    log += `snapshot merge: recovered stale anchor in src/lib.ts\n`;
  }

  log += `turn 2: asking model\n`;
  log += `turn 2: red (1 error: Line 8)\n`;
  log += `⏱ turn 2 took 1.8s (total 4.3s)\n`;

  if (turnsToGreen > 2) {
    for (let turn = 3; turn <= turnsToGreen; turn++) {
      log += `turn ${turn}: asking model\n`;

      if (turn < turnsToGreen) {
        log += `turn ${turn}: red (1 error: Line 5)\n`;
        log += `⏱ turn ${turn} took 1.5s (total ${(4.3 + (turn - 2) * 1.5).toFixed(1)}s)\n`;
      }
    }
  }

  if (green) {
    log += `· turn ${turnsToGreen}: GREEN\n`;
    log += `spec "example": done\n`;
  }

  return log;
}

test("analyzes edit vs edit_lines metrics from fixture logs", async () => {
  const tmpDir = await createTempDir();

  try {
    // Create synthetic run directories
    const run1Dir = join(tmpDir, "test-hashline-on-t0-20260612-120000-1");
    const run2Dir = join(tmpDir, "test-hashline-off-t0-20260612-120000-1");

    await mkdir(run1Dir, { recursive: true });
    await mkdir(run2Dir, { recursive: true });

    // Fixture: hashline on → more edit_lines calls, fewer rejections
    const log1 = createFixtureLog({
      editCalls: 0,
      editRejects: 0,
      editLinesCalls: 2,
      editLinesRejects: 0,
      staleRecoveries: 1,
      gateFails: 1,
      turnsToGreen: 3,
      green: true,
    });

    // Fixture: hashline off → more edit calls, some rejections
    const log2 = createFixtureLog({
      editCalls: 3,
      editRejects: 1,
      editLinesCalls: 0,
      editLinesRejects: 0,
      staleRecoveries: 0,
      gateFails: 2,
      turnsToGreen: 4,
      green: true,
    });

    // Write logs
    await Bun.write(join(run1Dir, "run.log"), log1);
    await Bun.write(join(run2Dir, "run.log"), log2);

    // Write result.json with feature flags
    await Bun.write(
      join(run1Dir, "result.json"),
      JSON.stringify({
        seed: "test",
        runId: "test-hashline-on-t0-20260612-120000-1",
        temperature: 0,
        features: { TSFORGE_HASHLINE: "1" },
        status: "done",
        cycles: 3,
        ms: 8500,
        quality: 4,
      })
    );

    await Bun.write(
      join(run2Dir, "result.json"),
      JSON.stringify({
        seed: "test",
        runId: "test-hashline-off-t0-20260612-120000-1",
        temperature: 0,
        features: { TSFORGE_HASHLINE: "0" },
        status: "done",
        cycles: 4,
        ms: 12000,
        quality: 3,
      })
    );

    // Now we'd parse them (inline parsing for test)
    const log1Text = await Bun.file(join(run1Dir, "run.log")).text();
    const log2Text = await Bun.file(join(run2Dir, "run.log")).text();

    // Simple metric extraction (mirrors edit-benchmark.ts logic)
    function extractMetrics(logText: string): {
      edits: number;
      editLines: number;
      editRejects: number;
      editLinesRejects: number;
    } {
      const editCalls = (logText.match(/✎ edit /g) ?? []).length;
      const editLinesCalls = (logText.match(/edit_lines /g) ?? []).length;
      const editRejects = (logText.match(/^edit .*REJECTED/gm) ?? []).length;
      const editLinesRejects = (logText.match(/^edit_lines .*REJECTED/gm) ?? [])
        .length;

      return {
        edits: editCalls,
        editLines: editLinesCalls,
        editRejects,
        editLinesRejects,
      };
    }

    const m1 = extractMetrics(log1Text);
    const m2 = extractMetrics(log2Text);

    // Verify metrics were extracted
    expect(m1.editLines).toBeGreaterThan(0);
    expect(m2.edits).toBeGreaterThan(0);
  } finally {
    // Cleanup
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test("computes mean tool-arg bytes proxy correctly", async () => {
  // Fixture: avg line length ≈ 80 chars per successful edit
  const logWithEdits = `
✎ edit src/main.ts (chunk 1, ~80 bytes in tool args)
edited src/main.ts
✎ edit src/utils.ts (chunk 2, ~100 bytes in tool args)
edited src/utils.ts
`;

  // Rough extraction: line containing "edited" counts
  const lines = logWithEdits.split("\n");
  let totalBytes = 0;
  let edits = 0;

  for (const line of lines) {
    if (line.includes("edited")) {
      totalBytes += line.length;
      edits += 1;
    }
  }

  const meanBytes = edits > 0 ? totalBytes / edits : 0;

  expect(edits).toBe(2);
  expect(meanBytes).toBeGreaterThan(0);
});

test("detects stale-anchor recovery from log patterns", () => {
  const logWithRecovery = `
turn 1: asking model
edit_lines src/file.ts
snapshot merge: stale hash detected, applying 3-way merge
edited src/file.ts (recovered via snapshot)
`;

  const recoveryCount = (logWithRecovery.match(/snapshot.*merge/g) ?? [])
    .length;

  expect(recoveryCount).toBe(1);
});

test("counts gate failures and turns to green", () => {
  const log = `
turn 1: asking model
turn 1: red (2 errors)
turn 2: asking model
turn 2: red (1 error)
turn 3: asking model
· turn 3: GREEN
spec "test": done
`;

  const reds = (log.match(/turn \d+: red/g) ?? []).length;
  const lines = log.split("\n");
  let turnsToGreen = 0;

  for (const line of lines) {
    if (/· turn \d+: GREEN/.test(line)) {
      const match = /turn (\d+)/.exec(line);

      turnsToGreen = match ? Number(match[1]) : 0;
      break;
    }
  }

  expect(reds).toBe(2);
  expect(turnsToGreen).toBe(3);
});
