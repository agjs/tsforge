import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ILoopEvent } from "../src/loop";
import {
  mineLessons,
  mergeCandidates,
  activeRules,
  consolidate,
  loadLedger,
  EMPTY_LEDGER,
  MIN_HITS_TO_ACTIVATE,
  DECAY_MS,
  type ICandidateLesson,
} from "../src/loop/memory";
import { parseProjectRules, TtsrManager } from "../src/loop/ttsr";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-mem-"));
}

function validated(rules: string[]): ILoopEvent {
  return {
    kind: "validated",
    task: "t",
    message: "",
    passed: rules.length === 0,
    rules,
  };
}

function edit(file: string, oldString: string, newString: string): ILoopEvent {
  return { kind: "edit", task: "t", message: "", file, oldString, newString };
}

function red(rules: string[]): ILoopEvent {
  return { kind: "red", task: "t", message: "", rules };
}

describe("mineLessons", () => {
  test("pairs a disappeared rule code with the edit that cleared it", () => {
    const events: ILoopEvent[] = [
      validated(["no-explicit-any"]),
      edit("src/a.ts", "const x: any = f()", "const x: number = f()"),
      validated([]), // green — the rule disappeared
    ];

    const candidates = mineLessons(events);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rule).toBe("no-explicit-any");
    expect(candidates[0]?.file).toBe("src/a.ts");
    expect(candidates[0]?.before).toContain("any");
  });

  test("mines a one-turn red→green fix seeded from the pre-run RED event", () => {
    // The headless loop's initial failure is a `red` event, not `validated`; a
    // single-turn fix has only a GREEN `validated` afterward. The miner must seed
    // the baseline from `red` or it learns nothing (regression: live e2e run 1).
    const events: ILoopEvent[] = [
      red(["TS2322"]),
      edit(
        "src/x.ts",
        'const greeting: number = "hello"',
        "const greeting = 42"
      ),
      validated([]),
    ];

    const candidates = mineLessons(events);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rule).toBe("TS2322");
  });

  test("ignores rules that persist (no fix happened)", () => {
    const events: ILoopEvent[] = [
      validated(["no-explicit-any"]),
      edit("src/a.ts", "let y = 1", "let y = 2"),
      validated(["no-explicit-any"]), // still failing
    ];

    expect(mineLessons(events)).toHaveLength(0);
  });

  test("does not learn from create (net-new file, no before-pattern)", () => {
    const events: ILoopEvent[] = [
      validated(["TS2307"]),
      {
        kind: "create",
        task: "t",
        message: "",
        file: "src/new.ts",
        content: "export const z = 1",
      },
      validated([]),
    ];

    expect(mineLessons(events)).toHaveLength(0);
  });

  test("skips pure insertions (empty before)", () => {
    const events: ILoopEvent[] = [
      validated(["TS18048"]),
      edit("src/a.ts", "   ", "if (x === undefined) { return; }"),
      validated([]),
    ];

    expect(mineLessons(events)).toHaveLength(0);
  });

  test("drops non-pattern gate verdicts but keeps every real rule id", () => {
    // The boringstack gate surfaces structural/behavioral VERDICTS — `reachability`
    // (route not wired), `judge` (quality critique), `bun-test`/`vitest` (failing
    // assertion), `syntax` (unparseable) — that name no code construct, so a mined keyed
    // to one is noise. Everything else is a real diagnostic id and stays learnable,
    // INCLUDING bare eslint core rules like `eqeqeq`/`curly` that carry no `/` or `-`
    // (this repo's gate enables them as errors — dropping them would be silent loss).
    const events: ILoopEvent[] = [
      red([
        "reachability",
        "judge",
        "bun-test",
        "vitest",
        "syntax",
        "knip/unused-files",
        "gate-nonzero",
        "TS2345",
        "no-invalid-void-type",
        "eqeqeq",
        "curly",
      ]),
      edit("src/a.ts", "async f(this: void)", "async f()"),
      validated([]),
    ];

    const rules = mineLessons(events)
      .map((c) => c.rule)
      .sort();

    expect(rules).toEqual([
      "TS2345",
      "curly",
      "eqeqeq",
      "no-invalid-void-type",
    ]);
  });
});

describe("mergeCandidates + activeRules", () => {
  const cand: ICandidateLesson = {
    rule: "no-explicit-any",
    file: "src/a.ts",
    before: "const x: any = f()",
    after: "const x: number = f()",
  };

  test("first session records the lesson at hits=1 (not yet active)", () => {
    const ledger = mergeCandidates(EMPTY_LEDGER, [cand], "sess-1", 1000);

    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.hits).toBe(1);
    expect(activeRules(ledger, 1000)).toHaveLength(0); // below MIN_HITS_TO_ACTIVATE
  });

  test("a SECOND session re-producing it bumps hits and activates", () => {
    const after1 = mergeCandidates(EMPTY_LEDGER, [cand], "sess-1", 1000);
    const after2 = mergeCandidates(after1, [cand], "sess-2", 2000);

    expect(after2.entries[0]?.hits).toBe(MIN_HITS_TO_ACTIVATE);

    const rules = activeRules(after2, 2000);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.scope).toBe("tool-args");
    expect(rules[0]?.guidance).toContain("no-explicit-any");
  });

  test("the same session producing it twice does NOT inflate hits", () => {
    const ledger = mergeCandidates(EMPTY_LEDGER, [cand, cand], "sess-1", 1000);

    expect(ledger.entries[0]?.hits).toBe(1);
  });

  test("a decayed (stale) active rule is dropped from the active set", () => {
    const after1 = mergeCandidates(EMPTY_LEDGER, [cand], "sess-1", 1000);
    const after2 = mergeCandidates(after1, [cand], "sess-2", 2000);

    // Now far in the future, past the decay window.
    expect(activeRules(after2, 2000 + DECAY_MS + 1)).toHaveLength(0);
    // ...but it remains in the ledger (accumulation is preserved).
    expect(after2.entries).toHaveLength(1);
  });

  test("an activated rule FIRES through the real TtsrManager (recall→fire)", () => {
    const led = mergeCandidates(
      mergeCandidates(EMPTY_LEDGER, [cand], "s1", 1000),
      [cand],
      "s2",
      2000
    );
    const [rule] = activeRules(led, 2000);
    const mgr = new TtsrManager();

    mgr.addRule(rule!);

    // The model re-emits the previously-failing snippet inside a tool call.
    const fired = mgr.checkDelta(cand.before, {
      source: "tool-args",
      currentFile: "src/a.ts",
    });

    expect(fired?.name).toBe(rule?.name);
  });

  test("activated rules carry no fileGlobs (so the glob matcher can't suppress them)", () => {
    const led = mergeCandidates(
      mergeCandidates(EMPTY_LEDGER, [cand], "s1", 1000),
      [cand],
      "s2",
      2000
    );

    expect(activeRules(led, 2000)[0]?.fileGlobs).toBeUndefined();
  });

  test("active rules round-trip through parseProjectRules (valid TTSR shape)", () => {
    const after2 = mergeCandidates(
      mergeCandidates(EMPTY_LEDGER, [cand], "s1", 1000),
      [cand],
      "s2",
      2000
    );
    const rules = activeRules(after2, 2000);
    const json = JSON.stringify(rules);

    // parseProjectRules is the real loader the harness uses — proves the file we
    // write is loadable as live TTSR rules.
    expect(parseProjectRules(json)).toHaveLength(1);
  });
});

describe("consolidate (disk)", () => {
  const cand: ICandidateLesson = {
    rule: "no-explicit-any",
    file: "src/a.tsx",
    before: "const x: any = f()",
    after: "const x: number = f()",
  };

  test("writes the ledger; activates only after the recurrence threshold", async () => {
    const dir = await tmp();

    try {
      const n1 = await consolidate(dir, [cand], "sess-1", 1000);

      expect(n1).toBe(0); // hits=1, not active yet
      const ledger1 = await loadLedger(dir);

      expect(ledger1.entries).toHaveLength(1);
      expect(ledger1.entries[0]?.hits).toBe(1);

      const n2 = await consolidate(dir, [cand], "sess-2", 2000);

      expect(n2).toBe(1); // now active
      const learned = await readFile(
        join(dir, ".tsforge", "learned-rules.json"),
        "utf8"
      );

      expect(parseProjectRules(learned)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no candidates → no files written, no throw", async () => {
    const dir = await tmp();

    try {
      const n = await consolidate(dir, [], "sess-1", 1000);

      expect(n).toBe(0);
      expect(
        await Bun.file(join(dir, ".tsforge", "memory.json")).exists()
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
