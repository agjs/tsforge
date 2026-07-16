import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isRecord } from "../lib/guards";
import {
  loadModelsConfig,
  resolveActiveModel,
  type IModelsConfig,
  type IModelEntry,
} from "../models-config";
import { resolvePanel, type IPanel } from "../reviewers/registry";
import { sliceBuildLog } from "../reviewers/log-slice";
import {
  diagnoseInvoke,
  aggregateDiagnoses,
  type IConsensus,
  type DiagOutcome,
} from "../reviewers/diagnose";
import type { IDiagnoseRequest } from "../reviewers/diagnose-schema";
import { makeProvider, runBinary } from "./harness-review-mode";

/** Injectable IO so the orchestration (missing-file path, independence guard,
 *  artifact write) is testable without real config, network, or filesystem. */
export interface IDiagnoseIo {
  readLog: (path: string) => Promise<string>;
  loadConfig: () => Promise<IModelsConfig>;
  resolveActive: () => Promise<{ name: string; entry: IModelEntry }>;
  invoke: (panel: IPanel, request: IDiagnoseRequest) => Promise<DiagOutcome[]>;
  writeArtifact: (fileName: string, body: string) => Promise<void>;
}

const realIo: IDiagnoseIo = {
  readLog: (path) => readFile(path, "utf-8"),
  loadConfig: loadModelsConfig,
  resolveActive: resolveActiveModel,
  invoke: (panel, request) =>
    diagnoseInvoke(panel, request, { makeProvider, runBinary }),
  writeArtifact: async (fileName, body) => {
    const dir = join(".tsforge", "harness-diagnose");

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName), body, "utf-8");
  },
};

const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_TAIL = 40;

interface IArgs {
  logFile: string | undefined;
  domain: string | undefined;
  reason: string | undefined;
  builder: string | undefined;
  maxChars: number;
  tail: number;
}

/** Parse a positive-integer flag value, ignoring missing/NaN/Infinity/≤0 so a
 *  bad `--max-chars`/`--tail` falls back to the default instead of poisoning the
 *  budget with NaN (which would make every `x <= NaN` comparison false → an
 *  empty, misleading slice). */
function posInt(value: string | undefined, fallbackValue: number): number {
  const n = Number(value);

  return Number.isInteger(n) && n > 0 ? n : fallbackValue;
}

export function parse(argv: string[]): IArgs {
  const out: IArgs = {
    logFile: undefined,
    domain: undefined,
    reason: undefined,
    builder: undefined,
    maxChars: DEFAULT_MAX_CHARS,
    tail: DEFAULT_TAIL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];

    if (a === undefined) {
      continue;
    }

    if (a === "--domain") {
      i += 1;
      out.domain = argv[i];
    } else if (a === "--reason") {
      i += 1;
      out.reason = argv[i];
    } else if (a === "--builder") {
      i += 1;
      out.builder = argv[i];
    } else if (a === "--max-chars") {
      i += 1;
      out.maxChars = posInt(argv[i], DEFAULT_MAX_CHARS);
    } else if (a === "--tail") {
      i += 1;
      out.tail = posInt(argv[i], DEFAULT_TAIL);
    } else if (!a.startsWith("--") && out.logFile === undefined) {
      out.logFile = a;
    }
  }

  return out;
}

/** Resolve an event's fields from either log shape: flat `{kind,message,…}` or
 *  the typed ledger `{type,payload:{…}}` (payload wins). */
function resolve(line: string): Record<string, unknown> | null {
  try {
    const o: unknown = JSON.parse(line);

    if (!isRecord(o)) {
      return null;
    }

    return isRecord(o.payload) ? { ...o, ...o.payload } : o;
  } catch {
    return null;
  }
}

export function deriveParkReason(raw: string): string {
  const fixMsgs: string[] = [];

  for (const line of raw.split("\n")) {
    const rec = resolve(line);
    const kind = rec?.kind ?? rec?.type;

    if (rec !== null && kind === "fix" && typeof rec.message === "string") {
      fixMsgs.push(rec.message);
    }
  }

  for (let i = fixMsgs.length - 1; i >= 0; i -= 1) {
    const m = fixMsgs[i];

    if (m !== undefined && /park|exhaust|fail/iu.test(m)) {
      return m;
    }
  }

  return fixMsgs.at(-1) ?? "unknown (no fix/park event found)";
}

/** The last observed turn/cycle number, as a short summary string. */
export function deriveTurns(raw: string): string {
  let last = 0;

  for (const line of raw.split("\n")) {
    const rec = resolve(line);
    const kind = rec?.kind ?? rec?.type;

    if (rec !== null && kind === "cycle" && typeof rec.cycle === "number") {
      last = rec.cycle;
    }
  }

  return last > 0 ? `${String(last)} cycles` : "unknown";
}

export function formatConsensus(c: IConsensus, identity: string): string {
  const lines: string[] = [];

  if (c.category === null) {
    lines.push(
      `harness-diagnose: NO CONSENSUS — 0 reviewers succeeded (errored: ${String(c.totalErrored)})`
    );

    return lines.join("\n");
  }

  lines.push(
    `harness-diagnose: ${c.category} (agreement ${String(c.agreement)}/${String(c.totalOk)}, errored ${String(c.totalErrored)}, builder ${identity})`
  );
  lines.push("");
  lines.push("Suggested harness fixes (from agreeing reviewers):");

  for (const f of c.suggestedFixes) {
    lines.push(`  - ${f}`);
  }

  lines.push("");
  lines.push("Per-reviewer:");

  for (const v of c.votes) {
    lines.push(
      `  [${v.reviewerId}] ${v.category} (${v.confidence}): ${v.rootCause}`
    );
  }

  return lines.join("\n");
}

export async function harnessDiagnoseMode(
  argv: string[],
  io: IDiagnoseIo = realIo
): Promise<number> {
  const args = parse(argv);

  if (args.logFile === undefined) {
    process.stdout.write(
      'usage: tsforge harness-diagnose <build-log.jsonl> [--domain X] [--reason "…"] [--builder <entry>] [--max-chars N] [--tail N]\n'
    );

    return 2;
  }

  let raw: string;

  try {
    raw = await io.readLog(args.logFile);
  } catch {
    process.stdout.write(`error: cannot read log file "${args.logFile}"\n`);

    return 2;
  }

  const cfg = await io.loadConfig();
  const active = await io.resolveActive();

  // Independence must be judged against the model that PRODUCED the transcript,
  // not whatever happens to be active now — otherwise, after switching models, a
  // log's real builder could sit on the panel and review its own run. The log
  // does not record its builder, so `--builder <entry>` names it. An UNKNOWN
  // entry is a hard error (never a silent downgrade to the active model); an
  // omitted flag falls back to the active model with a loud note.
  if (args.builder !== undefined && cfg.models[args.builder] === undefined) {
    process.stdout.write(
      `error: --builder "${args.builder}" is not a configured model in models.json\n`
    );

    return 2;
  }

  const override =
    args.builder !== undefined ? cfg.models[args.builder] : undefined;
  const builder =
    override !== undefined
      ? { name: args.builder ?? active.name, entry: override }
      : active;
  const panel = resolvePanel(cfg, builder);
  const identity = `${builder.name}/${builder.entry.model}`;

  if (args.builder === undefined) {
    process.stdout.write(
      `note: independence checked against the CURRENT active builder (${identity}); pass --builder <entry> if this log came from a different model\n`
    );
  }

  for (const s of panel.skipped) {
    process.stdout.write(`skipped reviewer ${s.id}: ${s.reason}\n`);
  }

  const slice = sliceBuildLog(raw, {
    maxChars: args.maxChars,
    tailLines: args.tail,
  });
  const request: IDiagnoseRequest = {
    domain: args.domain ?? "unknown",
    parkReason: args.reason ?? deriveParkReason(raw),
    turnsSummary: deriveTurns(raw),
    logSlice: slice.text,
    sliceNote: slice.note,
  };
  const outcomes = await io.invoke(panel, request);
  const consensus = aggregateDiagnoses(outcomes);

  process.stdout.write(`${formatConsensus(consensus, identity)}\n`);

  const key = createHash("sha256")
    .update(`${args.logFile}\n${slice.text}`)
    .digest("hex")
    .slice(0, 16);

  await io.writeArtifact(
    `${key}.json`,
    JSON.stringify(
      { request: { ...request, logSlice: undefined }, consensus, identity },
      null,
      2
    )
  );

  return 0;
}
