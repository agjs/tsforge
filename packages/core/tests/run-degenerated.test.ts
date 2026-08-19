import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/loop";
import type { IChatMessage, IProvider } from "../src/inference";
import { assistantMessage } from "../src/loop/assistant-message";

// The TTSR variant of this bug was fixed in run-ttsr.test.ts; the SAME shape
// existed on the neighbouring aborted paths. A degenerated/truncated response
// carries partial toolCalls the loop never executes — recording them leaves an
// assistant tool_calls message with no tool responses, which strict APIs 400 on
// the NEXT request.
test("assistantMessage strips partial tool calls for degenerated and truncated responses", () => {
  const degenerated = assistantMessage({
    content: "looping…",
    toolCalls: [{ id: "1", name: "create", arguments: { file: "x.ts" } }],
    degenerated: true,
  });

  expect(degenerated.toolCalls).toBeUndefined();
  expect(degenerated.content).toBe("looping…");

  const truncated = assistantMessage({
    content: "",
    toolCalls: [],
    truncated: true,
    finishReason: "length",
  });

  expect(truncated.toolCalls).toBeUndefined();
  // Never both content-less and tool-less — strict APIs reject that too.
  expect(truncated.content.length).toBeGreaterThan(0);

  // A normal response still records its calls (cloned).
  const normal = assistantMessage({
    content: "",
    toolCalls: [{ id: "1", name: "read", arguments: { file: "y.ts" } }],
  });

  expect(normal.toolCalls).toHaveLength(1);
});

test("runTask: a truncated response re-steers with a smaller-call message, no dangling tool_calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-run-trunc-"));

  try {
    const seen: {
      roles: string[];
      lastUser: string;
      dangling: number;
    }[] = [];
    let calls = 0;
    const provider: IProvider = {
      async complete(messages: readonly IChatMessage[]) {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");

        seen.push({
          roles: messages.map((m) => m.role),
          lastUser: lastUser?.content ?? "",
          dangling: messages.filter(
            (m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0
          ).length,
        });
        calls += 1;

        // Turn 1: the response hit the token cap mid-tool-call — the broken
        // call was dropped at assembly, truncated flagged.
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [],
            truncated: true,
            finishReason: "length",
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };

    await runTask({ id: "1", accept: "false", files: ["**/*"] }, dir, provider);

    expect(calls).toBeGreaterThanOrEqual(2);

    const retry = seen[1];

    // The re-steer names the cause and demands smaller pieces…
    expect(retry?.lastUser).toContain("CUT OFF");
    expect(retry?.lastUser).toContain("smaller");
    // …and the aborted turn left no dangling assistant tool_calls behind.
    expect(retry?.dangling).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
