import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConventionIndex,
  conventionTopics,
} from "../src/loop/conventions";
import type { IProvider, IChatMessage } from "../src/inference";
import { Session } from "../src/loop";

// WS-A1: the PUSH index that front-loads the pullable convention catalog so the model
// pulls the compliant pattern BEFORE writing (Bucket 1), complementing pull_conventions.

test("buildConventionIndex lists every pullable topic", () => {
  const index = buildConventionIndex();

  for (const topic of conventionTopics()) {
    expect(index).toContain(topic);
  }
});

test("buildConventionIndex tells the model to pull BEFORE writing", () => {
  const index = buildConventionIndex();

  expect(index).toContain("pull_conventions");
  expect(index).toContain("FIRST");
  // Cross-references the gate rules a topic prevents, so the model connects
  // topic → rule and knows what it's avoiding.
  expect(index).toContain("prevents:");
  expect(index).toContain("component-folder-structure");
});

// Behavioral: the index reaches the model's SYSTEM prompt only when the backend ships
// a convention library (pullConventions), so plain sessions stay minimal.
function systemCapturingProvider(cap: { system: string }): IProvider {
  return {
    async complete(messages: IChatMessage[]) {
      const sys = messages.find((m) => m.role === "system");

      cap.system = typeof sys?.content === "string" ? sys.content : "";

      return { content: "done", toolCalls: [] };
    },
  };
}

test("the convention index is in the system prompt with pullConventions, absent without", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-conv-"));

  try {
    const withConv = { system: "" };
    const on = await Session.create({
      provider: systemCapturingProvider(withConv),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      pullConventions: true,
    });

    await on.send("go");

    expect(withConv.system).toContain("STACK CONVENTIONS");

    const noConv = { system: "" };
    const off = await Session.create({
      provider: systemCapturingProvider(noConv),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
    });

    await off.send("go");

    expect(noConv.system).not.toContain("STACK CONVENTIONS");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
