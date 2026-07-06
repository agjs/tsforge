import { test, expect, describe } from "bun:test";
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
      ["agent_spawned", "agent_spawned"],
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

      const [event] = await read();
      const command = String(event?.payload.command ?? "");

      expect(command).not.toContain(secret);
      expect(command).toContain("[redacted]");
    });
  });

  test("preserves a non-plain object (Date → ISO string, not {})", async () => {
    await withLog(async (file, read) => {
      const when = new Date(0);

      new LedgerWriter(file, "r").record("run_started", { at: when });

      const [event] = await read();

      // Date serializes via its own toJSON, not flattened to an empty object.
      expect(event?.payload.at).toBe(when.toISOString());
    });
  });

  test("caps an over-long payload string to a preview", async () => {
    await withLog(async (file, read) => {
      const w = new LedgerWriter(file, "r");

      w.record("tool_call_finished", { output: "x".repeat(10_000) });

      const [event] = await read();
      const output = String(event?.payload.output ?? "");

      expect(output.length).toBeLessThan(10_000);
      expect(output).toContain("chars]");
    });
  });

  test("records agentId when given and omits it otherwise (round-trip)", async () => {
    await withLog(async (file, read) => {
      const w = new LedgerWriter(file, "run-1", "sess-1");

      w.record("agent_spawned", { spec: "explore" }, "run-1:explore");
      w.record("model_call_started", {}); // parent event — no agentId

      const [spawned, parent] = await read();

      expect(spawned?.agentId).toBe("run-1:explore");
      expect(parent?.agentId).toBeUndefined();
    });
  });

  test("omits sessionId when not provided; no-op without a file", async () => {
    await withLog(async (file, read) => {
      new LedgerWriter(file, "r").record("run_started", {});

      expect((await read())[0]?.sessionId).toBeUndefined();
    });

    // Empty file path ⇒ never throws, never writes.
    expect(() =>
      new LedgerWriter("", "r").record("run_started", {})
    ).not.toThrow();
  });
});
