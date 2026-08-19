/**
 * Deterministic TUI/runtime perf bench — the before/after evidence for every
 * render-path change. Drives PaneScreen against a byte-counting fake terminal
 * plus the two known runtime hot paths (session persist, streaming tool-args),
 * printing one JSON object per scenario so runs can be diffed by script:
 *
 *   TSFORGE_PERF=1 bun packages/core/scripts/bench-pane.ts
 *
 * Wall times are machine-dependent; compare runs on the SAME machine. The
 * paint counters (via paint-stats) are deterministic and comparable anywhere.
 */
import { PaneScreen } from "../src/render/frame/pane-screen";
import { paintStats, resetPaintStats } from "../src/render/frame/paint-stats";
import { saveSession, type ISessionRecord } from "../src/session-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.TSFORGE_PERF !== "1") {
  process.stderr.write(
    "bench-pane: run with TSFORGE_PERF=1 so paint counters are recorded\n"
  );
  process.exit(1);
}

class BenchTerm {
  isTTY = true;
  rows = 40;
  columns = 120;
  bytes = 0;

  write(data: string): boolean {
    this.bytes += data.length;

    return true;
  }
}

interface IScenarioResult {
  scenario: string;
  wallMs: number;
  fullPaints: number;
  mainOnlyPaints: number;
  inputOnlyPaints: number;
  appendMainCalls: number;
  setAgentTreeCalls: number;
  termBytes: number;
}

function freshPane(): { pane: PaneScreen; term: BenchTerm } {
  const term = new BenchTerm();
  const pane = new PaneScreen(term, 40, 120);

  pane.enter();

  return { pane, term };
}

/** Let queued setImmediate paints (coalescing) drain before sampling. */
function drain(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => {
      setImmediate(resolve);
    });
  });
}

async function scenario(
  name: string,
  term: BenchTerm,
  run: () => Promise<void> | void
): Promise<IScenarioResult> {
  resetPaintStats();
  const t0 = performance.now();

  await run();
  await drain();

  const wallMs = performance.now() - t0;
  const s = paintStats();

  return {
    scenario: name,
    wallMs: Math.round(wallMs * 10) / 10,
    fullPaints: s.fullPaints,
    mainOnlyPaints: s.mainOnlyPaints,
    inputOnlyPaints: s.inputOnlyPaints,
    appendMainCalls: s.appendMainCalls,
    setAgentTreeCalls: s.setAgentTreeCalls,
    termBytes: term.bytes,
  };
}

const results: IScenarioResult[] = [];

// 1. token-flood: 5000 small appends while following.
{
  const { pane, term } = freshPane();

  results.push(
    await scenario("token-flood", term, () => {
      for (let i = 0; i < 5000; i += 1) {
        pane.appendMain(i % 12 === 0 ? ` chunk-${i}\n` : ` chunk-${i}`);
      }
    })
  );
  pane.leave();
}

// 2. tree+stream: agent tree present, interleaved tree updates + appends.
{
  const { pane, term } = freshPane();
  const tree = (frame: number): string[] =>
    Array.from({ length: 12 }, (_, i) => `agent-row-${i} frame ${frame % 4}`);

  results.push(
    await scenario("tree+stream", term, () => {
      pane.setAgentTree(tree(0));

      for (let i = 0; i < 2000; i += 1) {
        pane.appendMain(` tok-${i}`);

        if (i % 10 === 0) {
          pane.setAgentTree(tree(i));
        }
      }
    })
  );
  pane.leave();
}

// 3. scrolled-up stream: user scrolled up, tokens keep arriving.
{
  const { pane, term } = freshPane();

  results.push(
    await scenario("scrolled-up-stream", term, async () => {
      for (let i = 0; i < 600; i += 1) {
        pane.appendMain(`line before scroll ${i}\n`);
      }

      pane.scrollMain(20);
      await drain();

      for (let i = 0; i < 2000; i += 1) {
        pane.appendMain(` tok-${i}${i % 12 === 0 ? "\n" : ""}`);
      }
    })
  );
  pane.leave();
}

// 4. paste: one 50KB chunk through the pane key/input filter path.
{
  const { pane, term } = freshPane();
  const paste = "lorem ipsum dolor sit amet ".repeat(1900); // ~51KB

  results.push(
    await scenario("paste-50kb", term, () => {
      // handleKey is where the per-cluster peel happens upstream in the REPL;
      // here we time the pane-side normalize/handle path per cluster.
      for (const ch of paste) {
        pane.handleKey(ch);
      }
    })
  );
  pane.leave();
}

// 5. status ticks: only the elapsed clock changes, 500 ticks.
{
  const { pane, term } = freshPane();

  results.push(
    await scenario("status-ticks", term, () => {
      for (let i = 0; i < 500; i += 1) {
        pane.setStatus({
          model: "bench-model",
          contextTokens: 1000,
          contextWindow: 100000,
          turns: 3,
          elapsedMs: i * 120,
          status: "running",
          scope: "bench",
          activity: `⠋ thinking · ${String(Math.floor((i * 120) / 1000))}s`,
        });
      }
    })
  );
  pane.leave();
}

// 6. persist: 500-message session saved 50 times (redaction amortization).
{
  const home = await mkdtemp(join(tmpdir(), "bench-persist-"));
  const prevHome = process.env.TSFORGE_HOME;

  process.env.TSFORGE_HOME = home;

  const record: ISessionRecord = {
    id: "bench",
    cwd: home,
    accept: "",
    files: ["**/*"],
    updatedAt: Date.now(),
    messages: Array.from({ length: 500 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${i} `.repeat(120),
    })),
  };
  const term = new BenchTerm();

  results.push(
    await scenario("persist-500msg-x50", term, async () => {
      for (let i = 0; i < 50; i += 1) {
        record.updatedAt = Date.now();
        await saveSession(record);
      }
    })
  );

  if (prevHome === undefined) {
    delete process.env.TSFORGE_HOME;
  } else {
    process.env.TSFORGE_HOME = prevHome;
  }

  await rm(home, { recursive: true, force: true });
}

for (const r of results) {
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
