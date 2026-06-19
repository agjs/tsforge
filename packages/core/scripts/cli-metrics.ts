// Turn a tsforge CLI `--log` (JSONL) into the metrics the local-Qwen literature
// says actually predict behavior — tokens-to-solution, repair iterations,
// hallucinated imports, peak context — measured against the model/window the log
// records. "Measure, don't assume": many apparent model failures are really
// quant/config/harness failures, so judge a run by these, not by vibes.
//
// Run:  bun run packages/core/scripts/cli-metrics.ts [logfile]
//   (no arg → the newest log under ~/.tsforge/logs)
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards";
import { classifyRun, parseEventLog } from "../src/eval";

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function newestLog(): Promise<string> {
  const dir = join(process.env.TSFORGE_HOME ?? homedir(), ".tsforge", "logs");
  // Filenames are ISO-timestamp-prefixed, so lexicographic sort = chronological.
  const names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
  const latest = names.at(-1);

  if (latest === undefined) {
    throw new Error(`no .jsonl logs in ${dir}`);
  }

  return join(dir, latest);
}

interface IMetrics {
  model: string;
  contextWindow: number;
  finalStatus: string;
  turns: number;
  modelCalls: number;
  tokensOut: number;
  peakContext: number;
  edits: number;
  filesCreated: number;
  gateRuns: number;
  compactions: number;
  buildNudges: number;
  salvaged: number;
  hallucinatedImports: string[];
  wallClockSeconds: number;
}

type EventRecord = Record<string, unknown>;

/** One counter per event kind — a flat registry keeps `analyze` branch-free. */
const HANDLERS: Record<
  string,
  (m: IMetrics, event: EventRecord, created: Set<string>) => void
> = {
  start: (m, e) => {
    if (str(e.model).length > 0) {
      m.model = str(e.model);
    }

    if (num(e.contextWindow) > 0) {
      m.contextWindow = num(e.contextWindow);
    }
  },
  cycle: (m) => {
    m.turns += 1;
  },
  usage: (m, e) => {
    m.modelCalls += 1;
    m.tokensOut += num(e.completionTokens);
    m.peakContext = Math.max(m.peakContext, num(e.promptTokens));
  },
  create: (m, e, created) => {
    m.edits += 1;

    if (str(e.file).length > 0) {
      created.add(str(e.file));
    }
  },
  edit: (m) => {
    m.edits += 1;
  },
  timing: (m, e) => {
    m.wallClockSeconds += Math.round(num(e.ms) / 1000);
  },
  validated: (m) => {
    m.gateRuns += 1;
  },
  done: (m) => {
    m.finalStatus = "done";
  },
  stuck: (m) => {
    m.finalStatus = "stuck";
  },
  tool: (m, e) => {
    const msg = str(e.message);

    m.compactions += msg.includes("compacted") ? 1 : 0;
    m.buildNudges += msg.includes("nudging") ? 1 : 0;
    m.salvaged += msg.includes("recovered") ? 1 : 0;
  },
};

function emptyMetrics(): IMetrics {
  return {
    model: "?",
    contextWindow: 0,
    finalStatus: "(none)",
    turns: 0,
    modelCalls: 0,
    tokensOut: 0,
    peakContext: 0,
    edits: 0,
    filesCreated: 0,
    gateRuns: 0,
    compactions: 0,
    buildNudges: 0,
    salvaged: 0,
    hallucinatedImports: [],
    wallClockSeconds: 0,
  };
}

function analyze(lines: string[]): IMetrics {
  const created = new Set<string>();
  const m = emptyMetrics();
  let allText = "";

  for (const line of lines) {
    let event: unknown;

    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(event)) {
      continue;
    }

    // The `--log` ledger wraps each event in `payload` ({type, payload:{kind,…}});
    // a legacy flat line IS the event. Read through whichever shape this line is,
    // or every field comes back empty and the metrics silently read zero. Gate on
    // top-level `kind` being ABSENT (only the wrapped shape lacks it) so a flat
    // event carrying its own `payload` field isn't misread as wrapped.
    const src =
      !("kind" in event) && isRecord(event.payload) ? event.payload : event;

    // Concatenate ALL message/output text, then scan once — a "Cannot find
    // module" can be split across streamed token chunks.
    allText += `${str(src.message)}\n${str(src.output)}\n`;
    HANDLERS[str(src.kind)]?.(m, src, created);
  }

  const hallucinated = new Set<string>();

  for (const match of allText.matchAll(
    /Cannot find module ['"]([^'"]+)['"]/g
  )) {
    hallucinated.add(match[1] ?? "");
  }

  m.filesCreated = created.size;
  m.hallucinatedImports = [...hallucinated];

  return m;
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? (await newestLog());
  const text = await Bun.file(path).text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const m = analyze(lines);
  // Single source of truth for WHY a run failed — the same classifier the eval
  // sweep and the reusable analyzeEvents() use, fed the typed event stream.
  const failure = classifyRun(parseEventLog(text));
  const pct =
    m.contextWindow > 0
      ? Math.round((m.peakContext / m.contextWindow) * 100)
      : 0;
  const imports =
    m.hallucinatedImports.length > 0
      ? `${m.hallucinatedImports.length} → ${m.hallucinatedImports.join(", ")}`
      : "0";

  const rows: [string, string][] = [
    ["log", path],
    ["model", m.model],
    ["context window", String(m.contextWindow)],
    ["final status", m.finalStatus],
    [
      "failure class",
      failure.detail === undefined
        ? failure.failureClass
        : `${failure.failureClass} (${failure.detail})`,
    ],
    ["turns (repair iterations)", String(m.turns)],
    ["model calls", String(m.modelCalls)],
    ["tokens out (→ solution)", String(m.tokensOut)],
    ["peak context", `${m.peakContext} (${pct}% of window)`],
    ["edits/creates", `${m.edits} (${m.filesCreated} files created)`],
    ["gate runs", String(m.gateRuns)],
    ["auto-compactions", String(m.compactions)],
    ["build nudges", String(m.buildNudges)],
    ["salvaged tool calls", String(m.salvaged)],
    ["hallucinated imports", imports],
    ["wall clock", `${m.wallClockSeconds}s`],
  ];

  for (const [label, value] of rows) {
    console.log(`${label.padEnd(26)} ${value}`);
  }
}

await main();
