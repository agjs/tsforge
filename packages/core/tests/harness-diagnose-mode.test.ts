import { test, expect, describe } from "bun:test";
import {
  parse,
  deriveParkReason,
  deriveTurns,
  formatConsensus,
  harnessDiagnoseMode,
  type IDiagnoseIo,
} from "../src/cli/harness-diagnose-mode";
import type { IConsensus, DiagOutcome } from "../src/reviewers/diagnose";
import type { IModelsConfig } from "../src/models-config";

function jsonl(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

describe("parse", () => {
  test("takes the first positional as the log file and reads flags", () => {
    const a = parse([
      "build.jsonl",
      "--domain",
      "expense",
      "--reason",
      "parked",
      "--max-chars",
      "5000",
      "--tail",
      "10",
    ]);

    expect(a.logFile).toBe("build.jsonl");
    expect(a.domain).toBe("expense");
    expect(a.reason).toBe("parked");
    expect(a.maxChars).toBe(5000);
    expect(a.tail).toBe(10);
  });

  test("logFile undefined when only flags are given", () => {
    expect(parse(["--domain", "x"]).logFile).toBeUndefined();
  });
});

describe("deriveParkReason", () => {
  test("returns the last park-flavored fix message (flat format)", () => {
    const raw = jsonl([
      { kind: "fix", message: "feature 'X': attempt 1" },
      { kind: "fix", message: "feature 'X': ladder exhausted, parked" },
    ]);

    expect(deriveParkReason(raw)).toContain("parked");
  });

  test("reads the typed-ledger payload format too", () => {
    const raw = jsonl([
      { type: "log", payload: { kind: "fix", message: "attempt 1" } },
      {
        type: "log",
        payload: { kind: "fix", message: "ladder exhausted, parked" },
      },
    ]);

    expect(deriveParkReason(raw)).toContain("parked");
  });

  test("falls back to a generic label when there is no fix event", () => {
    expect(deriveParkReason(jsonl([{ kind: "cycle", cycle: 1 }]))).toContain(
      "unknown"
    );
  });
});

describe("deriveTurns", () => {
  test("reports the last cycle number (flat)", () => {
    const raw = jsonl([
      { kind: "cycle", cycle: 1 },
      { kind: "cycle", cycle: 42 },
    ]);

    expect(deriveTurns(raw)).toBe("42 cycles");
  });

  test("reports the last cycle number (payload)", () => {
    const raw = jsonl([
      { type: "model_call_started", payload: { kind: "cycle", cycle: 7 } },
    ]);

    expect(deriveTurns(raw)).toBe("7 cycles");
  });

  test("unknown when no cycle events", () => {
    expect(deriveTurns(jsonl([{ kind: "fix", message: "x" }]))).toBe("unknown");
  });
});

describe("formatConsensus", () => {
  const base: IConsensus = {
    category: "gate-parity",
    agreement: 2,
    totalOk: 3,
    totalErrored: 1,
    votes: [
      {
        reviewerId: "glm",
        category: "gate-parity",
        confidence: "high",
        rootCause: "phantom rule",
        suggestedFix: "make gates identical",
      },
    ],
    suggestedFixes: ["make gates identical"],
  };

  test("renders the consensus category, agreement, and fixes", () => {
    const out = formatConsensus(base, "builder/model");

    expect(out).toContain("gate-parity");
    expect(out).toContain("agreement 2/3");
    expect(out).toContain("make gates identical");
    expect(out).toContain("[glm]");
  });

  test("reports NO CONSENSUS when no reviewer succeeded", () => {
    const out = formatConsensus(
      {
        category: null,
        agreement: 0,
        totalOk: 0,
        totalErrored: 2,
        votes: [],
        suggestedFixes: [],
      },
      "builder/model"
    );

    expect(out).toContain("NO CONSENSUS");
  });
});

describe("harnessDiagnoseMode (orchestration, injected IO)", () => {
  const builderEntry = { baseUrl: "http://192.168.0.1/v1", model: "flash" };
  const cfg: IModelsConfig = {
    active: "builder-x",
    models: {
      "builder-x": builderEntry,
      "rev-a": { baseUrl: "https://api.other.com/v1", model: "pro" },
    },
    reviewPanel: {
      minReviewers: 2,
      reviewers: [{ kind: "model", id: "rev-a", entry: "rev-a" }],
    },
  };
  const okOutcome: DiagOutcome = {
    status: "ok",
    diagnosis: {
      reviewerId: "rev-a",
      category: "gate-parity",
      confidence: "high",
      rootCause: "phantom rule",
      suggestedFix: "reconcile against the validator",
    },
  };

  function makeIo(overrides: Partial<IDiagnoseIo> = {}): {
    io: IDiagnoseIo;
    written: { name: string; body: string }[];
  } {
    const written: { name: string; body: string }[] = [];
    const io: IDiagnoseIo = {
      readLog: () =>
        Promise.resolve(JSON.stringify({ kind: "fix", message: "parked" })),
      loadConfig: () => Promise.resolve(cfg),
      resolveActive: () =>
        Promise.resolve({ name: "builder-x", entry: builderEntry }),
      invoke: () => Promise.resolve([okOutcome]),
      writeArtifact: (name, body) => {
        written.push({ name, body });

        return Promise.resolve();
      },
      ...overrides,
    };

    return { io, written };
  }

  test("usage + exit 2 when no log file is given", async () => {
    const { io } = makeIo();

    expect(await harnessDiagnoseMode([], io)).toBe(2);
  });

  test("exit 2 when the log file cannot be read", async () => {
    const { io } = makeIo({
      readLog: () => Promise.reject(new Error("ENOENT")),
    });

    expect(await harnessDiagnoseMode(["missing.jsonl"], io)).toBe(2);
  });

  test("unknown --builder is a HARD error (exit 2), never a silent fallback", async () => {
    const { io, written } = makeIo();

    expect(
      await harnessDiagnoseMode(["log.jsonl", "--builder", "nope"], io)
    ).toBe(2);
    expect(written).toHaveLength(0);
  });

  test("happy path: exit 0 and writes an artifact with the consensus + identity", async () => {
    const { io, written } = makeIo();

    const code = await harnessDiagnoseMode(["log.jsonl", "--domain", "x"], io);

    expect(code).toBe(0);
    expect(written).toHaveLength(1);

    const parsed: unknown = JSON.parse(written[0]?.body ?? "{}");

    expect(parsed).toMatchObject({
      identity: "builder-x/flash",
      consensus: { category: "gate-parity" },
    });
  });

  test("--builder names the log's real builder for identity + independence", async () => {
    const { io, written } = makeIo();

    await harnessDiagnoseMode(["log.jsonl", "--builder", "builder-x"], io);

    const parsed: unknown = JSON.parse(written[0]?.body ?? "{}");

    expect(parsed).toMatchObject({ identity: "builder-x/flash" });
  });
});
