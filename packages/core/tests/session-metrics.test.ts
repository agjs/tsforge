import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";
import type { ILoopEvent } from "../src/loop/loop.types";

/** A provider that streams one token (so a generation time is measured) and
 *  reports token usage, with no tool calls (the "model is done" case). */
function providerWithUsage(): IProvider {
  return {
    async complete(_messages, options) {
      options?.onToken?.("hello", "content");

      return {
        content: "hello",
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      };
    },
  };
}

test("session metrics accumulate token usage and a generation rate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-metrics-"));

  try {
    const session = await Session.create({
      provider: providerWithUsage(),
      cwd: dir,
    });

    expect(session.metrics.calls).toBe(0);

    await session.send("hi");

    const m = session.metrics;

    expect(m.calls).toBe(1);
    expect(m.promptTokens).toBe(100);
    expect(m.completionTokens).toBe(20);
    expect(m.avgTokensPerSecond).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(m.avgTokensPerSecond)).toBe(true);
    expect(Number.isFinite(m.lastTokensPerSecond)).toBe(true);

    await session.send("again");

    expect(session.metrics.calls).toBe(2);
    expect(session.metrics.promptTokens).toBe(200);
    expect(session.metrics.completionTokens).toBe(40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the session's usage record keeps a generation rate and the cache figure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-metrics-"));

  try {
    // usageEvent() is unit-tested, but nothing pinned that the SESSION still
    // hands it a genMs — losing that would silently drop tok/s from the
    // interactive path while every usageEvent test stayed green.
    const events: ILoopEvent[] = [];
    const session = await Session.create({
      provider: {
        async complete(_messages, options) {
          options?.onToken?.("hello", "content");

          return {
            content: "hello",
            toolCalls: [],
            usage: {
              promptTokens: 100,
              completionTokens: 20,
              totalTokens: 120,
              cachedPromptTokens: 75,
            },
          };
        },
      },
      cwd: dir,
      report: (e) => events.push(e),
    });

    await session.send("hi");

    const usage = events.filter((e) => e.kind === "usage");

    expect(usage.length).toBe(1);
    expect(usage[0]?.tokensPerSecond).toBeDefined();
    expect(usage[0]?.ms).toBeDefined();
    expect(usage[0]?.cachedPromptTokens).toBe(75);
    expect(usage[0]?.message).toContain("75 cached (75%)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
