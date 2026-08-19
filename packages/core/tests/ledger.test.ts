import { test, expect, describe, spyOn } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LedgerWriter,
  ledgerTypeFor,
  type IBaseLedgerEvent,
  type ILoopEvent,
  type LedgerEventType,
} from "../src/loop";
import { makeReporter } from "../src/cli/logging";
import { parseEventLog } from "../src/eval";

async function withLog<T>(
  fn: (file: string, read: () => Promise<IBaseLedgerEvent[]>) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-ledger-"));
  const file = join(dir, "run.jsonl");

  const read = async (): Promise<IBaseLedgerEvent[]> => {
    const text = await readFile(file, "utf8");
    const out: IBaseLedgerEvent[] = [];

    for (const line of text.split("\n")) {
      if (line.length > 0) {
        const parsed: IBaseLedgerEvent = JSON.parse(line);

        out.push(parsed);
      }
    }

    return out;
  };

  try {
    return await fn(file, read);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ledgerTypeFor — kind → typed event", () => {
  test("maps boundary kinds to ledger types", () => {
    const cases: readonly [ILoopEvent["kind"], LedgerEventType][] = [
      ["start", "run_started"],
      ["done", "run_finished"],
      ["stuck", "run_finished"],
      ["cycle", "model_call_started"],
      ["usage", "model_call_finished"],
      ["validated", "gate_finished"],
      ["edit", "tool_call_finished"],
      ["create", "tool_call_finished"],
      ["run", "tool_call_finished"],
      ["policy", "policy_decision"],
      ["inject", "model_inject"],
      ["agent_spawned", "agent_spawned"],
      ["agent_started", "agent_started"],
      ["agent_result", "agent_result"],
      ["timing", "log"],
    ];

    for (const [kind, type] of cases) {
      // Cast-free: every test kind is a real ILoopEvent kind.
      expect(ledgerTypeFor({ kind, task: "t", message: "" })).toBe(type);
    }
  });

  test("a rejected tool event maps to tool_call_failed", () => {
    expect(
      ledgerTypeFor({
        kind: "tool",
        task: "t",
        message: "tool_rejected:run (x)",
      })
    ).toBe("tool_call_failed");
    expect(
      ledgerTypeFor({ kind: "tool", task: "t", message: "↳ bun add zod" })
    ).toBe("log");
  });
});

describe("LedgerWriter", () => {
  test("writes one valid JSON line per record, in order, with metadata", async () => {
    await withLog(async (file, read) => {
      const w = new LedgerWriter(file, "run-1", "sess-1");

      w.record("run_started", { model: "x" });
      w.record("tool_call_finished", { file: "a.ts" });

      w.flush();

      const events = await read();

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe("run_started");
      expect(events[1]?.type).toBe("tool_call_finished");
      expect(events[0]?.runId).toBe("run-1");
      expect(events[0]?.sessionId).toBe("sess-1");
      expect(typeof events[0]?.eventId).toBe("string");
      expect(typeof events[0]?.timestamp).toBe("string");
    });
  });

  test("redacts secrets in payload strings", async () => {
    await withLog(async (file, read) => {
      const w = new LedgerWriter(file, "r");
      // Built at runtime so no literal token sits in source (gitleaks); redactText
      // still matches `sk-[A-Za-z0-9_-]{16,}` on the assembled value.
      const secret = `sk-${"a1B2c3D4".repeat(3)}`;

      w.record("tool_call_finished", { command: `deploy --token ${secret}` });

      w.flush();

      const [event] = await read();
      const command = String(event?.payload.command ?? "");

      expect(command).not.toContain(secret);
      expect(command).toContain("[redacted]");
    });
  });

  test("preserves a non-plain object (Date → ISO string, not {})", async () => {
    await withLog(async (file, read) => {
      const when = new Date(0);
      const w = new LedgerWriter(file, "r");

      w.record("run_started", { at: when });
      w.flush();

      const [event] = await read();

      // Date serializes via its own toJSON, not flattened to an empty object.
      expect(event?.payload.at).toBe(when.toISOString());
    });
  });

  test("caps an over-long payload string to a preview", async () => {
    await withLog(async (file, read) => {
      const w = new LedgerWriter(file, "r");

      w.record("tool_call_finished", { output: "x".repeat(10_000) });

      w.flush();

      const [event] = await read();
      const output = String(event?.payload.output ?? "");

      expect(output.length).toBeLessThan(10_000);
      expect(output).toContain("chars]");
    });
  });

  test("model_inject keeps the full text under its wider cap", async () => {
    await withLog(async (file, read) => {
      const w = new LedgerWriter(file, "r");
      // A realistic settle wall: >4KB (the generic cap) but under the 32KB
      // inject cap — the whole point of the event is the FULL injected text.
      const wall = "3 error(s) remaining.\n" + "e".repeat(8_000);

      w.record("model_inject", { kind: "inject", message: wall });

      w.flush();

      const [event] = await read();
      const message = String(event?.payload.message ?? "");

      expect(message).toBe(wall);
      expect(message).not.toContain("chars]");
    });
  });

  test("records agentId when given and omits it otherwise (round-trip)", async () => {
    await withLog(async (file, read) => {
      const w = new LedgerWriter(file, "run-1", "sess-1");

      w.record("agent_spawned", { spec: "explore" }, "run-1:explore");
      w.record("model_call_started", {}); // parent event — no agentId

      w.flush();

      const [spawned, parent] = await read();

      expect(spawned?.agentId).toBe("run-1:explore");
      expect(parent?.agentId).toBeUndefined();
    });
  });

  test("omits sessionId when not provided; no-op without a file", async () => {
    await withLog(async (file, read) => {
      const w = new LedgerWriter(file, "r");

      w.record("run_started", {});
      w.flush();
      expect((await read())[0]?.sessionId).toBeUndefined();
    });

    // Empty file path ⇒ never throws, never writes.
    expect(() =>
      new LedgerWriter("", "r").record("run_started", {})
    ).not.toThrow();
  });
});

describe("agent attribution write→read round-trip", () => {
  test("makeReporter --log lines parse back with agentId/parentTask intact", async () => {
    await withLog(async (file) => {
      const report = makeReporter(file, "run-1", "sess-1");
      // Silence terminal rendering; the ledger file is what we assert on.
      const spy = spyOn(process.stdout, "write").mockImplementation(() => true);

      try {
        report({
          kind: "agent_spawned",
          task: "run-1",
          message: "explore (qwen3-coder)",
          agentId: "run-1:explore",
          parentTask: "run-1",
        });
        report({
          kind: "usage",
          task: "run-1:explore",
          message: "",
          totalTokens: 42,
          agentId: "run-1:explore",
        });
        report({ kind: "usage", task: "run-1", message: "" }); // parent event
        report({
          kind: "agent_result",
          task: "run-1",
          message: "3 findings",
          agentId: "run-1:explore",
          parentTask: "run-1",
          passed: true,
        });
      } finally {
        spy.mockRestore();
      }

      // The ledger batches writes per event-loop tick — let the flush run.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      const events = parseEventLog(await readFile(file, "utf8"));
      const spawned = events.find((e) => e.kind === "agent_spawned");
      const result = events.find((e) => e.kind === "agent_result");
      const child = events.find(
        (e) => e.kind === "usage" && e.agentId !== undefined
      );
      const parent = events.find(
        (e) => e.kind === "usage" && e.agentId === undefined
      );

      expect(spawned?.agentId).toBe("run-1:explore");
      expect(spawned?.parentTask).toBe("run-1");
      expect(result?.agentId).toBe("run-1:explore");
      expect(result?.passed).toBe(true);
      expect(child?.agentId).toBe("run-1:explore");
      expect(child?.totalTokens).toBe(42);
      expect(parent).toBeDefined();
    });
  });
});
