#!/usr/bin/env bun
/**
 * Run a web gate as SEQUENTIAL, LABELLED stages instead of one opaque `&&` chain.
 * Each stage prints a `━━ <label> ━━` banner, streams its output live, and on the
 * first failure prints `✗ <label> FAILED (exit N)` and stops — so the gate feedback
 * (and the human) can see WHICH stage broke, not just a wall of mixed output.
 *
 * Invoked by the gate command as `bun staged-gate.ts <base64-json>`, where the
 * payload is a base64-encoded JSON array of `{ label, command }`. base64 keeps the
 * (quoted, &&-containing, env-prefixed) stage commands intact through the shell
 * with zero escaping. Output is forwarded to this process's stdout so the outer
 * gate runner captures it exactly as it did the old chained command.
 */
import { runShellCommand } from "../src/lib/fs/process";
import { isRecord } from "../src/lib/guards";

interface IStage {
  readonly label: string;
  readonly command: string;
}

/** Parse + validate the base64 stage payload; throws on any malformed shape so a
 *  bad gate config fails loudly (exit 2) rather than silently running nothing. */
function parseStages(arg: string): readonly IStage[] {
  const json = Buffer.from(arg, "base64").toString("utf8");
  const parsed: unknown = JSON.parse(json);

  if (!Array.isArray(parsed)) {
    throw new Error("stage payload must be a JSON array");
  }

  return parsed.map((entry, i) => {
    if (
      !isRecord(entry) ||
      typeof entry.label !== "string" ||
      typeof entry.command !== "string"
    ) {
      throw new Error(`stage ${i} must have string label + command`);
    }

    return { label: entry.label, command: entry.command };
  });
}

async function main(): Promise<number> {
  const arg = process.argv[2];

  if (arg === undefined || arg.length === 0) {
    process.stderr.write("staged-gate: missing stage payload\n");

    return 2;
  }

  let stages: readonly IStage[];

  try {
    stages = parseStages(arg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    process.stderr.write(`staged-gate: ${message}\n`);

    return 2;
  }

  const cwd = process.cwd();

  for (const stage of stages) {
    process.stdout.write(`\n━━ ${stage.label} ━━\n`);

    const run = await runShellCommand(cwd, stage.command, {
      onChunk: (text) => process.stdout.write(text),
    });

    if (run.exitCode !== 0) {
      process.stdout.write(
        `\n✗ ${stage.label} FAILED (exit ${run.exitCode})\n`
      );

      // Preserve the failing stage's exit code so the outer gate still sees non-zero.
      return run.exitCode;
    }

    process.stdout.write(`✓ ${stage.label}\n`);
  }

  process.stdout.write("\n✓ all gate stages passed\n");

  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);

    process.stderr.write(`staged-gate: ${message}\n`);
    process.exit(1);
  });
