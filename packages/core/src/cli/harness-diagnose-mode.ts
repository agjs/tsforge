import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isRecord } from "../lib/guards";
import { loadModelsConfig, resolveActiveModel } from "../models-config";
import { resolvePanel } from "../reviewers/registry";
import { sliceBuildLog } from "../reviewers/log-slice";
import {
  diagnoseInvoke,
  aggregateDiagnoses,
  type IConsensus,
} from "../reviewers/diagnose";
import { makeProvider, runBinary } from "./harness-review-mode";

const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_TAIL = 40;

interface IArgs {
  logFile: string | undefined;
  domain: string | undefined;
  reason: string | undefined;
  maxChars: number;
  tail: number;
}

export function parse(argv: string[]): IArgs {
  const out: IArgs = {
    logFile: undefined,
    domain: undefined,
    reason: undefined,
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
    } else if (a === "--max-chars") {
      i += 1;
      out.maxChars = Number(argv[i]);
    } else if (a === "--tail") {
      i += 1;
      out.tail = Number(argv[i]);
    } else if (!a.startsWith("--") && out.logFile === undefined) {
      out.logFile = a;
    }
  }

  return out;
}

/** Best-effort extraction of the park reason from the last `fix` event that
 *  mentions a park; falls back to the last fix message, then a generic label. */
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

export async function harnessDiagnoseMode(argv: string[]): Promise<number> {
  const args = parse(argv);

  if (args.logFile === undefined) {
    process.stdout.write(
      'usage: tsforge harness-diagnose <build-log.jsonl> [--domain X] [--reason "…"] [--max-chars N] [--tail N]\n'
    );

    return 2;
  }

  const raw = await readFile(args.logFile, "utf-8");
  const slice = sliceBuildLog(raw, {
    maxChars: args.maxChars,
    tailLines: args.tail,
  });
  const cfg = await loadModelsConfig();
  const active = await resolveActiveModel();
  const panel = resolvePanel(cfg, active);

  for (const s of panel.skipped) {
    process.stdout.write(`skipped reviewer ${s.id}: ${s.reason}\n`);
  }

  const request = {
    domain: args.domain ?? "unknown",
    parkReason: args.reason ?? deriveParkReason(raw),
    turnsSummary: deriveTurns(raw),
    logSlice: slice.text,
    sliceNote: slice.note,
  };
  const outcomes = await diagnoseInvoke(panel, request, {
    makeProvider,
    runBinary,
  });
  const consensus = aggregateDiagnoses(outcomes);
  const identity = `${active.name}/${active.entry.model}`;

  process.stdout.write(`${formatConsensus(consensus, identity)}\n`);

  const key = createHash("sha256")
    .update(`${args.logFile}\n${slice.text}`)
    .digest("hex")
    .slice(0, 16);
  const dir = join(".tsforge", "harness-diagnose");

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${key}.json`),
    JSON.stringify(
      { request: { ...request, logSlice: undefined }, consensus, identity },
      null,
      2
    ),
    "utf-8"
  );

  return 0;
}
