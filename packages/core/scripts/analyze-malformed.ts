#!/usr/bin/env bun
// Correlate tool-call repair incidents with the per-call thinking mode,
// across every JSONL event log we have (~/.tsforge/logs + evals/runs). Tracks:
//   - Per-rule repair rates (L0: drop-null, unwrap-autolink; L1: coerce:*; etc.)
//   - L3 re-ask frequency (when repair gave up)
//   - Correlation with thinking mode (hypothesis: thinking-off has higher failure)
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
  repairs: Map<string, number>; // rule name → count
  reasks: number; // L3 re-ask count
}

type ThinkingMode = "on" | "off" | "unknown";

const buckets: Record<ThinkingMode, IBucket> = {
  on: {
    calls: 0,
    salvaged: 0,
    malformedNudges: 0,
    repairs: new Map(),
    reasks: 0,
  },
  off: {
    calls: 0,
    salvaged: 0,
    malformedNudges: 0,
    repairs: new Map(),
    reasks: 0,
  },
  unknown: {
    calls: 0,
    salvaged: 0,
    malformedNudges: 0,
    repairs: new Map(),
    reasks: 0,
  },
};

function modeOf(event: Record<string, unknown>): ThinkingMode {
  if (event.thinking === true) {
    return "on";
  }

  return event.thinking === false ? "off" : "unknown";
}

/** The thinking mode of the most recent usage event — repair events
 *  carry no flag of their own (they fire after the call), so they inherit it. */
let lastCallMode: ThinkingMode = "unknown";

function ingestTool(event: Record<string, unknown>): void {
  const msg = event.message;

  if (typeof msg !== "string") {
    return;
  }

  if (msg.includes("recovered") && msg.includes("malformed")) {
    // Salvage warnings carry their own per-call flag (new logs).
    buckets[
      event.thinking === undefined ? lastCallMode : modeOf(event)
    ].salvaged += 1;
  }

  if (msg.includes("malformed tool-call text")) {
    buckets[lastCallMode].malformedNudges += 1;
  }
}

function ingestRepair(event: Record<string, unknown>): void {
  const mode = event.thinking === undefined ? lastCallMode : modeOf(event);
  const bucket = buckets[mode];
  const msg = event.message;

  if (typeof msg !== "string") {
    return;
  }

  // Format: "tool:L0:drop-null:field" or "tool:L1:coerce:files" or "tool:L3-re-ask"
  const parts = msg.split(":");

  if (parts[parts.length - 1] === "L3-re-ask") {
    bucket.reasks += 1;
  } else {
    // Extract the rule name (e.g. "drop-null:field" → "drop-null")
    const rule = parts.slice(1).join(":");

    bucket.repairs.set(rule, (bucket.repairs.get(rule) ?? 0) + 1);
  }
}

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

  if (event.kind === "tool") {
    ingestTool(event);

    return;
  }

  if (event.kind === "repair") {
    ingestRepair(event);
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

function repairRate(b: IBucket): string {
  const totalRepairs = Array.from(b.repairs.values()).reduce(
    (a, c) => a + c,
    0
  );

  if (b.calls === 0) {
    return "—";
  }

  return `${((totalRepairs / b.calls) * 100).toFixed(2)}%`;
}

process.stdout.write(`scanned ${String(logs.length)} log file(s)\n\n`);

// Salvage & malformed incidents by thinking mode
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
  "\n" +
    "incident-rate = (salvaged + malformed-nudges) / model calls. 'unknown' =\n" +
    "logs predating the per-call thinking flag.\n"
);

// Repair ladder statistics
process.stdout.write("\n\nREPAIR LADDER STATISTICS:\n\n");
process.stdout.write("thinking  calls  repairs  reasks  repair-rate\n");

for (const mode of ["on", "off", "unknown"] as const) {
  const b = buckets[mode];
  const totalRepairs = Array.from(b.repairs.values()).reduce(
    (a, c) => a + c,
    0
  );

  process.stdout.write(
    `${mode.padEnd(9)} ${String(b.calls).padStart(5)}  ${String(totalRepairs).padStart(7)}  ${String(b.reasks).padStart(5)}  ${repairRate(b)}\n`
  );
}

// Top repair rules across all modes
const allRules = new Map<string, number>();

for (const b of Object.values(buckets)) {
  for (const [rule, count] of b.repairs) {
    allRules.set(rule, (allRules.get(rule) ?? 0) + count);
  }
}

if (allRules.size > 0) {
  process.stdout.write("\n\nTOP REPAIR RULES (across all modes):\n");
  const sorted = Array.from(allRules.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  for (const [rule, count] of sorted) {
    process.stdout.write(`  ${String(count).padStart(5)}  ${rule}\n`);
  }
}

process.stdout.write(
  "\n" +
    "repair-rate = total repairs / model calls. Re-run as new logs accumulate;\n" +
    "track per-rule rates to identify systemic model failures worth adding L2\n" +
    "safe-defaults for. L3 re-ask rate should trend to near-zero (recoverable\n" +
    "repairs succeed; unrecoverable args are infrequent and addressed in prompting).\n"
);
