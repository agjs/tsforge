#!/usr/bin/env bun
// Correlate MALFORMED tool-call incidents with the per-call thinking mode,
// across every JSONL event log we have (~/.tsforge/logs + evals/runs). The
// hypothesis under test: interactive thinking-OFF calls break tool-call
// formatting more often (both live malformed captures happened thinking-off).
//
//   bun packages/core/scripts/analyze-malformed.ts
//
// Old logs predate the per-call `thinking` field — those calls land in the
// "unknown" bucket; rates firm up as new logs accumulate.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isRecord } from "../src/lib/guards";

interface IBucket {
  calls: number;
  salvaged: number;
  malformedNudges: number;
}

type ThinkingMode = "on" | "off" | "unknown";

const buckets: Record<ThinkingMode, IBucket> = {
  on: { calls: 0, salvaged: 0, malformedNudges: 0 },
  off: { calls: 0, salvaged: 0, malformedNudges: 0 },
  unknown: { calls: 0, salvaged: 0, malformedNudges: 0 },
};

function modeOf(event: Record<string, unknown>): ThinkingMode {
  if (event.thinking === true) {
    return "on";
  }

  return event.thinking === false ? "off" : "unknown";
}

/** The thinking mode of the most recent usage event — malformed-nudge events
 *  carry no flag of their own (they fire after the call), so they inherit it. */
let lastCallMode: ThinkingMode = "unknown";

function ingestLine(line: string): void {
  let event: unknown;

  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (!isRecord(event) || typeof event.message !== "string") {
    return;
  }

  if (event.kind === "usage") {
    lastCallMode = modeOf(event);
    buckets[lastCallMode].calls += 1;

    return;
  }

  if (event.kind !== "tool") {
    return;
  }

  if (
    event.message.includes("recovered") &&
    event.message.includes("malformed")
  ) {
    // Salvage warnings carry their own per-call flag (new logs).
    buckets[
      event.thinking === undefined ? lastCallMode : modeOf(event)
    ].salvaged += 1;
  }

  if (event.message.includes("malformed tool-call text")) {
    buckets[lastCallMode].malformedNudges += 1;
  }
}

function ingestFile(path: string): void {
  lastCallMode = "unknown";

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length > 0) {
      ingestLine(line);
    }
  }
}

function collectLogs(): string[] {
  const files: string[] = [];
  const home = join(homedir(), ".tsforge", "logs");

  if (existsSync(home)) {
    for (const f of readdirSync(home)) {
      if (f.endsWith(".jsonl")) {
        files.push(join(home, f));
      }
    }
  }

  const runs = join("evals", "runs");

  if (existsSync(runs)) {
    for (const dir of readdirSync(runs)) {
      for (const name of ["events.jsonl", "run.jsonl", "log.jsonl"]) {
        const candidate = join(runs, dir, name);

        if (existsSync(candidate)) {
          files.push(candidate);
        }
      }
    }
  }

  return files;
}

const logs = collectLogs();

for (const f of logs) {
  ingestFile(f);
}

function rate(b: IBucket): string {
  if (b.calls === 0) {
    return "—";
  }

  return `${(((b.salvaged + b.malformedNudges) / b.calls) * 100).toFixed(2)}%`;
}

process.stdout.write(`scanned ${String(logs.length)} log file(s)\n\n`);
process.stdout.write(
  "thinking  calls  salvaged  malformed-nudges  incident-rate\n"
);

for (const mode of ["on", "off", "unknown"] as const) {
  const b = buckets[mode];

  process.stdout.write(
    `${mode.padEnd(9)} ${String(b.calls).padStart(5)}  ${String(b.salvaged).padStart(8)}  ${String(b.malformedNudges).padStart(16)}  ${rate(b)}\n`
  );
}

process.stdout.write(
  "\nincident-rate = (salvaged + malformed-nudges) / model calls. 'unknown' =\n" +
    "logs predating the per-call thinking flag. Re-run as new logs accumulate;\n" +
    "a clearly higher OFF rate would justify revisiting interactive thinking.\n"
);
