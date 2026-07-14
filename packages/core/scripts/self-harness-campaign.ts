// The 24/7 Self-Harness campaign: prove arXiv 2606.09498 on our stack.
//
//   1. FREEZE h_0: evaluate the base harness on the PINNED proof split at
//      repeats=2 → campaign/baseline.json. Never recomputed.
//   2. LOOP until campaign/STOP exists: health-gate the endpoint, run one
//      mining session (self-harness.ts subprocess, rotating splits), chain
//      accepted overlays via --initial-overlay, log to CAMPAIGN.md.
//   3. Every K sessions and on STOP: evaluate the current overlay on the
//      proof split (repeats=2) and write PROOF.md — pass rates before/after
//      with 95% Wilson CIs and a two-proportion z-test (the paper's Fig-4
//      analog). The proof split is NEVER used for mining (exam ≠ homework).
//
// Hard rules: nothing is ever installed to ~/.tsforge/self-harness (the
// campaign overlay lives under evals/self-harness/campaign/); the gate,
// acceptance rule, and tolerances are never touched at runtime; all model
// traffic is sequential (single-connection endpoint).
//
// Run:  bun packages/core/scripts/self-harness-campaign.ts
//         [--max-sessions N] [--proof-every 3] [--rounds 3] [--width 3]
// Stop: touch evals/self-harness/campaign/STOP  (in-flight session finishes)
import { mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OpenAICompatibleProvider } from "../src/inference";
import type { IProvider } from "../src/inference";
import { resolveActiveModel, resolveApiKey } from "../src/models-config";
import { providerConfig } from "../src/cli";
import {
  evaluateHarness,
  parseOverlay,
  isEmptyPatch,
  mergeOverlay,
  emptyOverlay,
  type IHarnessOverlay,
} from "../src/self-harness";
import type { IRunRecord } from "../src/eval";
import { buildSweepReport, renderSweepReportMarkdown } from "../src/eval";
import { isRecord } from "../src/lib/guards";

/** The exam: never shown to a mining session. Retargeted to the SPEC corpus
 *  (`evals/corpus/*`) after the UI-only web build corpus was removed — use the
 *  two hardest held-out tasks (a multi-file greenfield `auth` + the brownfield
 *  `fix-regression`) so a promoted overlay must generalize across task shapes with
 *  real headroom, not the trivially-green single-module tasks.
 *  FUTURE: once a BoringStack full-stack corpus exists, point this at it — that is
 *  the successor to the removed web corpus and the strictest regression floor. */
const PROOF_SPLIT = ["auth", "fix-regression"] as const;

/** Mining rotations over the SPEC corpus (disjoint from the proof split), the
 *  tasks with real weaknesses to mine and headroom for an overlay to prove itself.
 *  Alternate per session. (Also succeeded by a BoringStack corpus in future.) */
const ROTATIONS = [
  {
    heldIn: "checkout,debounce,validators,handlers",
    heldOut: "query,rate-limit",
  },
  {
    heldIn: "slugify,math,fixtures,migrate",
    heldOut: "query,rate-limit",
  },
] as const;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;

  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

const maxSessions = Number(argValue("max-sessions") ?? "1000");
const proofEvery = Number(argValue("proof-every") ?? "3");
const rounds = argValue("rounds") ?? "3";
const width = argValue("width") ?? "3";
// Concurrent mining sessions per batch. The endpoint batches up to 10 seqs on
// recipe-stock config; 2 leaves headroom for the human user's own coding.
const parallel = Math.max(
  1,
  Math.min(Number(argValue("parallel") ?? "2"), ROTATIONS.length)
);

const evalsRoot = join(import.meta.dir, "..", "..", "..", "evals");
const corpusDir = join(evalsRoot, "corpus");
const campaignDir = join(evalsRoot, "self-harness", "campaign");
const stopFile = join(campaignDir, "STOP");
const baselinePath = join(campaignDir, "baseline.json");
const overlayPath = join(campaignDir, "current-overlay.json");
const campaignLog = join(campaignDir, "CAMPAIGN.md");
const proofPath = join(campaignDir, "PROOF.md");
const SELF_HARNESS = join(import.meta.dir, "self-harness.ts");

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const { entry } = await resolveActiveModel();
const provider: IProvider = new OpenAICompatibleProvider(providerConfig(entry));

await mkdir(campaignDir, { recursive: true });

// Never overwrite a previous campaign's artifacts. Each launch moves any
// existing runs/ + sessions/ into archive/<launch-timestamp>/ before starting,
// so relaunching gives a clean slate AND keeps the prior run intact for
// comparison. (Per-task dirs are also wiped individually at run time; this is
// the campaign-level guard against cross-launch mixing.)
const launchStamp = new Date().toISOString().replace(/[:.]/gu, "-");

for (const sub of ["runs", "sessions"]) {
  const src = join(campaignDir, sub);

  if (existsSync(src)) {
    const dest = join(campaignDir, "archive", launchStamp, sub);

    await mkdir(join(campaignDir, "archive", launchStamp), { recursive: true });
    await rename(src, dest);
    say(`archived previous ${sub}/ → archive/${launchStamp}/${sub}`);
  }
}

if (!existsSync(campaignLog)) {
  await Bun.write(
    campaignLog,
    `# Self-Harness campaign — ${entry.model}\n\nProof split (never mined): ${PROOF_SPLIT.join(", ")}\n\n| # | time | rotation (in / out) | accepted | rejected | notes |\n|---|------|--------------------|----------|----------|-------|\n`
  );
}

async function appendLog(line: string): Promise<void> {
  const current = await Bun.file(campaignLog).text();

  await Bun.write(campaignLog, `${current}${line}\n`);
}

function now(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

/** One real-sized completion probe. */
async function probeOnce(): Promise<boolean> {
  try {
    const key = resolveApiKey(entry);
    const res = await fetch(`${entry.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify({
        model: entry.model,
        messages: [
          {
            role: "user",
            content:
              "Write a TypeScript semver parser with validation. Code only.",
          },
        ],
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    return res.ok;
  } catch {
    return false;
  }
}

/** 3 consecutive real completions, 60s apart; retries forever (the campaign
 *  outlives endpoint weather — that's its job). */
async function waitForHealthyEndpoint(): Promise<void> {
  let ok = 0;

  for (;;) {
    if (existsSync(stopFile)) {
      return; // let the main loop observe STOP
    }

    ok = (await probeOnce()) ? ok + 1 : 0;

    if (ok >= 3) {
      say("endpoint stable (3 consecutive real completions)");

      return;
    }

    await Bun.sleep(60_000);
  }
}

async function loadCurrentOverlay(): Promise<IHarnessOverlay | null> {
  if (!existsSync(overlayPath)) {
    return null;
  }

  const parsed = parseOverlay(JSON.parse(await Bun.file(overlayPath).text()));

  return parsed !== null && !isEmptyPatch(parsed) ? parsed : null;
}

/** Per-task retry cap for infrastructure-errored measurements. */
const TASK_MEASURE_ATTEMPTS = 3;

/**
 * Evaluate a harness variant on the proof split at repeats=2, relabelled for
 * the sweep report. Measured TASK BY TASK so an endpoint flap mid-measurement
 * discards (and retries) only the affected task's runs, never the whole ~1.5h
 * measurement. Honest by construction: an errored run is a NON-result — a
 * verdict-carrying run (pass or fail) is never re-rolled.
 */
async function measureProof(
  overlay: IHarnessOverlay | null,
  label: string,
  runsDir: string
): Promise<IRunRecord[]> {
  const all: IRunRecord[] = [];

  for (const taskId of PROOF_SPLIT) {
    let done = false;

    for (let attempt = 1; attempt <= TASK_MEASURE_ATTEMPTS; attempt += 1) {
      const outcome = await evaluateHarness([taskId], {
        corpusDir,
        runsDir: join(
          runsDir,
          attempt === 1 ? "." : `retry-${String(attempt)}`
        ),
        provider,
        repeats: 2,
        overlay,
        log: say,
      });

      if (outcome.score.errored === 0) {
        all.push(...outcome.records.map((r) => ({ ...r, label })));
        done = true;
        break;
      }

      say(
        `${taskId}: ${String(outcome.score.errored)} errored run(s) on attempt ${String(attempt)} — waiting for a healthy endpoint, then retrying the task`
      );
      await waitForHealthyEndpoint();
    }

    if (!done) {
      throw new Error(
        `${taskId}: still erroring after ${String(TASK_MEASURE_ATTEMPTS)} attempts — measurement discarded, not recorded`
      );
    }
  }

  return all;
}

async function loadBaseline(): Promise<IRunRecord[]> {
  if (existsSync(baselinePath)) {
    const parsed: unknown = JSON.parse(await Bun.file(baselinePath).text());

    if (Array.isArray(parsed)) {
      say(`baseline: loaded frozen h_0 (${String(parsed.length)} records)`);

      // Trusted file written by this script; runtime-checked shape minimum.
      return parsed.filter(
        (r): r is IRunRecord =>
          typeof r === "object" && r !== null && "passed" in r
      );
    }
  }

  // A discarded measurement (errored runs) must not kill the campaign — the
  // whole point of the driver is to outlive endpoint weather. Retry until a
  // CLEAN baseline exists or STOP is requested.
  for (let attempt = 1; !existsSync(stopFile); attempt += 1) {
    say(
      `baseline: freezing h_0 on the proof split (repeats=2, attempt ${String(attempt)})…`
    );
    await waitForHealthyEndpoint();

    try {
      const records = await measureProof(
        null,
        "baseline",
        join(campaignDir, "runs", `baseline-a${String(attempt)}`)
      );

      await Bun.write(baselinePath, JSON.stringify(records, null, 2));
      say(`baseline: frozen → ${baselinePath}`);

      return records;
    } catch (err) {
      say(
        `baseline attempt ${String(attempt)} discarded: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  throw new Error("STOP requested before a clean baseline was frozen");
}

async function writeProof(
  baseline: readonly IRunRecord[],
  sessionsDone: number
): Promise<void> {
  const overlay = await loadCurrentOverlay();

  if (overlay === null) {
    say("proof: no accepted overlay yet — skipping measurement");

    return;
  }

  say("proof: measuring current overlay on the proof split…");
  await waitForHealthyEndpoint();

  const current = await measureProof(
    overlay,
    "self-harness",
    join(campaignDir, "runs", `proof-after-${String(sessionsDone)}`)
  );
  const report = buildSweepReport([...baseline, ...current], "baseline");
  const md = [
    `# PROOF — Self-Harness uplift of ${entry.model}`,
    "",
    `After ${String(sessionsDone)} mining session(s). Proof split (never mined): ${PROOF_SPLIT.join(", ")}. repeats=2 per measurement.`,
    "",
    renderSweepReportMarkdown(report),
    "",
    "## Promoted overlay under test",
    "",
    "```json",
    JSON.stringify(overlay, null, 2),
    "```",
    "",
    `_Generated ${now()}. The paper's claim reproduces iff the self-harness row shows a positive, significant delta vs baseline._`,
    "",
  ].join("\n");

  await Bun.write(proofPath, md);
  say(`proof → ${proofPath}`);
}

interface ISessionOutcome {
  readonly accepted: number;
  readonly rejected: number;
  readonly note: string;
  readonly outDir: string;
}

/** Accepted/rejected tallies from a session's lineage.json (guard-parsed —
 *  a malformed file degrades to zeros, never a crash). */
function lineageCounts(value: unknown): {
  accepted: number;
  rejected: number;
} {
  let accepted = 0;
  let rejected = 0;

  if (isRecord(value) && Array.isArray(value.rounds)) {
    for (const round of value.rounds) {
      if (!isRecord(round)) {
        continue;
      }

      const ids = Array.isArray(round.acceptedIds)
        ? round.acceptedIds.length
        : 0;
      const candidates = Array.isArray(round.candidates)
        ? round.candidates.length
        : 0;

      accepted += ids;
      rejected += candidates - ids;
    }
  }

  return { accepted, rejected };
}

async function runSession(index: number): Promise<ISessionOutcome> {
  const rotation = ROTATIONS[index % ROTATIONS.length];

  if (rotation === undefined) {
    throw new Error("no rotation configured");
  }

  const outDir = join(campaignDir, "sessions", `s${String(index + 1)}`);
  const args = [
    "bun",
    SELF_HARNESS,
    "--rounds",
    rounds,
    "--width",
    width,
    "--held-in",
    rotation.heldIn,
    "--held-out",
    rotation.heldOut,
    "--out-dir",
    outDir,
  ];

  if (existsSync(overlayPath)) {
    args.push("--initial-overlay", overlayPath);
  }

  say(`session ${String(index + 1)}: ${rotation.heldIn} / ${rotation.heldOut}`);
  await mkdir(outDir, { recursive: true });

  // Per-session log file — parallel sessions must not interleave on stdout.
  const proc = Bun.spawn(args, {
    env: { ...process.env },
    stdout: Bun.file(join(outDir, "session.log")),
    stderr: Bun.file(join(outDir, "session.err.log")),
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return {
      accepted: 0,
      rejected: 0,
      note: `session process exited ${String(exitCode)}`,
      outDir,
    };
  }

  const lineagePath = join(outDir, "lineage.json");

  if (!existsSync(lineagePath)) {
    return { accepted: 0, rejected: 0, note: "no lineage written", outDir };
  }

  const lineage: unknown = JSON.parse(await Bun.file(lineagePath).text());
  const { accepted, rejected } = lineageCounts(lineage);

  return { accepted, rejected, note: "ok", outDir };
}

/**
 * Chain a batch's ACCEPTED candidate patches onto the shared overlay, in
 * session order. Parallel sessions each validated against the batch's shared
 * starting overlay; merging their accepted edits without cross-re-validation
 * is the paper's own MergeAccepted semantics for same-round candidates — the
 * next proof measurement gates the combination regardless.
 */
/** All ACCEPTED, validated, non-empty candidate patches in a lineage. */
function acceptedPatches(lineage: unknown): IHarnessOverlay[] {
  if (!isRecord(lineage) || !Array.isArray(lineage.rounds)) {
    return [];
  }

  const patches: IHarnessOverlay[] = [];

  for (const round of lineage.rounds) {
    const candidates =
      isRecord(round) && Array.isArray(round.candidates)
        ? round.candidates
        : [];

    for (const result of candidates) {
      if (
        !isRecord(result) ||
        result.accepted !== true ||
        !isRecord(result.candidate)
      ) {
        continue;
      }

      const patch = parseOverlay(result.candidate.patch);

      if (patch !== null && !isEmptyPatch(patch)) {
        patches.push(patch);
      }
    }
  }

  return patches;
}

async function chainAcceptedPatches(
  outcomes: readonly ISessionOutcome[]
): Promise<number> {
  let current = (await loadCurrentOverlay()) ?? emptyOverlay();
  let merged = 0;

  for (const outcome of outcomes) {
    const lineagePath = join(outcome.outDir, "lineage.json");

    if (!existsSync(lineagePath)) {
      continue;
    }

    const lineage: unknown = JSON.parse(await Bun.file(lineagePath).text());

    for (const patch of acceptedPatches(lineage)) {
      current = mergeOverlay(current, patch);
      merged += 1;
    }
  }

  if (merged > 0) {
    await Bun.write(overlayPath, `${JSON.stringify(current, null, 2)}\n`);
    say(`chained ${String(merged)} accepted edit(s) → ${overlayPath}`);
  }

  return merged;
}

// ---------------------------------------------------------------------------

say(`campaign — model ${entry.model}`);
say(`  stop with: touch ${stopFile}`);

const baseline = await loadBaseline();
let sessions = 0;

while (sessions < maxSessions && !existsSync(stopFile)) {
  await waitForHealthyEndpoint();

  if (existsSync(stopFile)) {
    break;
  }

  // A batch = `parallel` concurrent sessions on DISJOINT rotations. Each is
  // its own subprocess (own overlay env, own run dirs), so there is no
  // cross-contamination; the server batches the concurrent streams.
  const batchSize = Math.min(parallel, maxSessions - sessions);
  const indices = Array.from({ length: batchSize }, (_, j) => sessions + j);

  say(
    `launching ${String(batchSize)} parallel session(s): ${indices.map((i) => String(i + 1)).join(", ")}`
  );

  const outcomes = await Promise.all(indices.map((i) => runSession(i)));

  sessions += batchSize;

  for (const [j, outcome] of outcomes.entries()) {
    const index = indices[j] ?? 0;
    const rotation = ROTATIONS[index % ROTATIONS.length];

    await appendLog(
      `| ${String(index + 1)} | ${now()} | ${rotation?.heldIn ?? "?"} / ${rotation?.heldOut ?? "?"} | ${String(outcome.accepted)} | ${String(outcome.rejected)} | ${outcome.note} |`
    );
  }

  await chainAcceptedPatches(outcomes);

  const proofsBefore = Math.floor((sessions - batchSize) / proofEvery);
  const proofsAfter = Math.floor(sessions / proofEvery);

  if (proofsAfter > proofsBefore) {
    try {
      await writeProof(baseline, sessions);
    } catch (err) {
      say(
        `proof measurement failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

say(
  `campaign loop ended after ${String(sessions)} session(s) — final proof measurement…`
);

try {
  await writeProof(baseline, sessions);
} catch (err) {
  say(
    `final proof failed: ${err instanceof Error ? err.message : String(err)}`
  );
}

say(
  "campaign done. Review PROOF.md and CAMPAIGN.md; installing any overlay stays a human decision."
);
