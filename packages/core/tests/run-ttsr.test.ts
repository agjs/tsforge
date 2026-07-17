import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/loop";
import type { IChatMessage, IProvider } from "../src/inference";

// The runTask (headless) path had the same dangling-tool_calls bug as Session: it pushed
// the aborted turn's partial tool_calls, so the NEXT request carried an assistant
// tool_calls with no tool responses → strict-API 400. This exercises runTask end-to-end
// through a TTSR-aborted response and inspects the retry request's history.
test("runTask: a TTSR abort leaves NO dangling assistant tool_calls in the next request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-run-ttsr-"));

  try {
    const seen: { role: string; toolCalls?: readonly unknown[] }[][] = [];
    let calls = 0;
    const provider: IProvider = {
      async complete(messages: readonly IChatMessage[]) {
        seen.push(
          messages.map((m) => ({ role: m.role, toolCalls: m.toolCalls }))
        );
        calls += 1;

        // Turn 1: a tool call aborted mid-stream by TTSR (partial, never executed).
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "create", arguments: { file: "x.ts" } },
            ],
            ttsrFired: { ruleName: "no-as-cast", guidance: "no as casts" },
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };

    // Gate starts RED (`false`) so runTask actually calls the model (it pre-checks the
    // gate and exits early when already green). The model never fixes it, so the loop
    // ends stuck — but the TTSR retry (2nd request) is all this test inspects.
    await runTask({ id: "1", accept: "false", files: ["**/*"] }, dir, provider);

    // The 2nd request is the TTSR retry — the point a dangling tool_calls would 400.
    const retry = seen[1] ?? [];
    const dangling = retry.filter(
      (m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0
    );

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(dangling).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
