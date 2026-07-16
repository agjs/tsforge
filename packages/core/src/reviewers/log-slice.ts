import { isRecord } from "../lib/guards";

/** A bounded, signal-first extract of a build transcript, safe (and cheap) to
 *  hand to a paid review panel. NEVER truncates silently: dedupe counts and any
 *  budget drops are reported in `note`, so a reviewer knows it is seeing a
 *  compressed summary, not the whole run. */
export interface ILogSlice {
  text: string;
  totalLines: number;
  keptLines: number;
  droppedLines: number;
  note: string;
}

/** Lines whose content names a failure/progress signal are the spine of the
 *  story a diagnoser needs (park reasons, gate errors, regressions, acceptance
 *  state) — kept ahead of ordinary context. */
const SIGNAL =
  /parked|ladder exhausted|revisit|no-unsafe|prettier|regress|stuck|oscillat|escalat|expert|acceptance|verified|gate|phantom|memory\.json|error|fail|❌|✗/iu;

interface IClassified {
  /** Full, uncapped rendering — the dedupe identity. Two events are "the same"
   *  only if their FULL text matches, so distinct events that merely share a
   *  240-char prefix are never falsely collapsed. */
  key: string;
  /** Capped display text (message and diagnostics capped SEPARATELY so a long
   *  command prefix can't truncate the actual compiler/test error away). */
  text: string;
  signal: boolean;
  fix: boolean;
}

/** Message portion of a line is capped short; diagnostics get their own, larger
 *  budget so the real failure survives (see IClassified.text). */
const HEAD_CAP = 160;
const DIAG_CAP = 300;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function flat(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

function capTo(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** First non-empty string, else "". Avoids `a || b` on strings (which the
 *  strict-boolean-expressions rule rejects). */
function pick(...vals: string[]): string {
  for (const v of vals) {
    if (v !== "") {
      return v;
    }
  }

  return "";
}

/** Command output / gate diagnostics live in `output`/`errors`/`detail`, not in
 *  `message` (a `run` event's message is often just `$ bun run validate`). Pull a
 *  short diagnostic tail so the reviewer sees the ACTUAL failure, but only when
 *  it is diagnostic — a green `find` dump would be pure token cost. */
function diagnostics(rec: Record<string, unknown>): string {
  const parts: string[] = [];

  if (Array.isArray(rec.errors)) {
    parts.push(rec.errors.map((e) => str(e)).join("; "));
  }

  for (const field of ["output", "detail"]) {
    const v = rec[field];

    if (typeof v === "string" && v.length > 0) {
      parts.push(v);
    }
  }

  return parts.join(" ");
}

/** Render one JSONL event as a flattened, capped single line. Handles BOTH log
 *  shapes: the flat reporter jsonl (`{kind,message,…}`) and the typed
 *  `LedgerWriter` ledger (`{type,payload:{…}}`) — fields resolve from either
 *  level. Falls back to the raw line for non-JSON input (plain logs). Signal is
 *  detected on the FULL text (incl. diagnostics) before capping. */
function fallback(line: string): IClassified {
  const f = flat(line);

  return {
    key: f,
    text: capTo(f, HEAD_CAP + DIAG_CAP),
    signal: SIGNAL.test(f),
    fix: false,
  };
}

function classify(line: string): IClassified {
  let obj: unknown;

  try {
    obj = JSON.parse(line);
  } catch {
    return fallback(line);
  }

  if (!isRecord(obj)) {
    return fallback(line);
  }

  // Merge the typed-ledger `payload` up so a nested writer reads the same way as
  // the flat one (payload wins on conflict — it holds the event's real fields).
  const rec: Record<string, unknown> = isRecord(obj.payload)
    ? { ...obj, ...obj.payload }
    : obj;
  const kind = pick(str(rec.kind), str(rec.type), "?");
  const msg = pick(str(rec.message), str(rec.command));
  const extra: string[] = [];

  if (typeof rec.file === "string") {
    extra.push(rec.file);
  }

  const failed = typeof rec.exitCode === "number" && rec.exitCode !== 0;

  if (failed) {
    extra.push(`exit=${String(rec.exitCode)}`);
  }

  const diag = diagnostics(rec);
  // Include diagnostics when the event failed or the output itself names a
  // signal — otherwise a green command's stdout is dropped as pure noise.
  const withDiag = failed || SIGNAL.test(diag) ? flat(diag) : "";
  const head = flat(
    `[${kind}] ${msg}${extra.length > 0 ? ` (${extra.join(" ")})` : ""}`
  );
  // Full text is the dedupe key; display caps head and diagnostics separately so
  // a verbose command prefix can never truncate the failure diagnostic away.
  const key = withDiag.length > 0 ? `${head} :: ${withDiag}` : head;
  const text =
    withDiag.length > 0
      ? `${capTo(head, HEAD_CAP)} :: ${capTo(withDiag, DIAG_CAP)}`
      : capTo(head, HEAD_CAP);

  return {
    key,
    text,
    signal: kind === "fix" || SIGNAL.test(key),
    fix: kind === "fix",
  };
}

interface IUnique {
  key: string; // full text — the dedupe identity
  text: string; // capped display text
  idx: number; // last occurrence, so ordering reflects when it last mattered
  count: number;
  signal: boolean;
  fix: boolean;
  tail: boolean;
}

function render(u: IUnique): string {
  return u.count > 1 ? `${u.text} (×${String(u.count)})` : u.text;
}

const lineCost = (u: IUnique): number => render(u).length + 1;

/** Build a cheap, signal-first slice within a hard character ceiling. Dedupes
 *  identical events (a phantom rule repeated 21× becomes one line "(×21)"),
 *  drops bulk low-signal context (reads, policy checks, tool noise) outside the
 *  tail window, and fills the budget in priority order: fix/park events → other
 *  signal lines → recent context. Every drop is counted and reported. */
export function sliceBuildLog(
  raw: string,
  opts: { maxChars: number; tailLines: number }
): ILogSlice {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const total = lines.length;
  const tailStart = Math.max(0, total - opts.tailLines);

  // Dedupe by FULL text (the key), remembering the last position + count. Two
  // events collapse only if their full text is identical; flags are OR-merged so
  // a later occurrence that is signal/fix/tail is never demoted.
  const byText = new Map<string, IUnique>();

  lines.forEach((line, idx) => {
    const c = classify(line);
    const tail = idx >= tailStart;
    const prev = byText.get(c.key);

    if (prev === undefined) {
      byText.set(c.key, {
        key: c.key,
        text: c.text,
        idx,
        count: 1,
        signal: c.signal,
        fix: c.fix,
        tail,
      });
    } else {
      prev.count += 1;
      prev.idx = idx;
      prev.signal = prev.signal || c.signal;
      prev.fix = prev.fix || c.fix;
      prev.tail = prev.tail || tail;
    }
  });

  const uniq = [...byText.values()];
  const tiers = {
    fix: uniq.filter((u) => u.fix),
    signal: uniq.filter((u) => u.signal && !u.fix),
    context: uniq.filter((u) => u.tail && !u.signal && !u.fix),
  };
  // Non-tail, non-signal context (reads, policy checks, tool spam) is dropped
  // wholesale — it is the bulk of the tokens and the least diagnostic value.

  const picked: IUnique[] = [];
  const dropped = { fix: 0, signal: 0, context: 0 };
  let running = 0;

  const fill = (list: IUnique[], tier: keyof typeof dropped): void => {
    for (const u of [...list].sort((a, b) => b.idx - a.idx)) {
      if (running + lineCost(u) <= opts.maxChars) {
        running += lineCost(u);
        picked.push(u);
      } else {
        dropped[tier] += 1;
      }
    }
  };

  fill(tiers.fix, "fix");
  fill(tiers.signal, "signal");
  fill(tiers.context, "context");

  picked.sort((a, b) => a.idx - b.idx);

  const text = picked.map(render).join("\n");
  const representedEvents = picked.reduce((s, u) => s + u.count, 0);
  const droppedLines = total - representedEvents;
  const budgetDrops = dropped.fix + dropped.signal + dropped.context;
  const note =
    droppedLines === 0
      ? `compacted view of all ${String(total)} events (each summarized to one capped line: message + diagnostics on failures; identical lines deduped as "(×N)"; verbose green output elided)`
      : [
          `SUMMARY (compressed for cost): ${String(picked.length)} unique lines representing ${String(representedEvents)} of ${String(total)} events (identical lines deduped as "(×N)").`,
          `Dropped ${String(droppedLines)} events: bulk low-signal context outside the last ${String(opts.tailLines)}` +
            (budgetDrops > 0
              ? `, plus ${String(budgetDrops)} lines cut for the ${String(opts.maxChars)}-char budget (fix ${String(dropped.fix)}, signal ${String(dropped.signal)}, context ${String(dropped.context)})`
              : ""),
        ].join(" ");

  return {
    text,
    totalLines: total,
    keptLines: picked.length,
    droppedLines,
    note,
  };
}
