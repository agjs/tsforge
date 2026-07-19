import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConventionGuides,
  conventionGuide,
  conventionTopics,
} from "../src/loop/conventions";
import type { IProvider, IChatMessage } from "../src/inference";
import { Session } from "../src/loop";

// WS-A1: front-load the actual convention GUIDES (the compliant patterns), not merely a
// topic index — so the model writes it right the FIRST time (Bucket 1) instead of pulling
// only reactively after the gate rejects it.

test("buildConventionGuides front-loads the actual guide CONTENT for every topic", () => {
  const guides = buildConventionGuides();

  // The full compliant pattern for each topic is present — not just its name.
  for (const topic of conventionTopics()) {
    expect(guides).toContain(conventionGuide(topic));
  }
});

test("buildConventionGuides carries the concrete patterns that prevent the traced sprays", () => {
  const guides = buildConventionGuides();

  // The exact idioms the model was guessing wrong (the inv157 1→8 spray classes):
  expect(guides).toContain("@/lib/api/client"); // data-fetching (no fetch/axios)
  expect(guides).toContain("src/features/"); // component anatomy / layout
  expect(guides).toContain("TYPE GUARD"); // no-casts (no `as`/`!`)
  expect(guides).toContain("hooks.ts"); // state lives in hooks, not the body
});

test("buildConventionGuides tells the model to write it right BEFORE the gate", () => {
  const guides = buildConventionGuides();

  expect(guides).toContain("BEFORE you write");
  expect(guides).toContain("FIRST");
});

// Behavioral: the guides reach the model's SYSTEM prompt only when the backend ships a
// convention library (pullConventions), so plain sessions stay minimal.
function systemCapturingProvider(cap: { system: string }): IProvider {
  return {
    async complete(messages: IChatMessage[]) {
      const sys = messages.find((m) => m.role === "system");

      cap.system = typeof sys?.content === "string" ? sys.content : "";

      return { content: "done", toolCalls: [] };
    },
  };
}

test("the convention guides are in the system prompt with pullConventions, absent without", async () => {
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

    expect(withConv.system).toContain("HOW THIS STACK WRITES CODE");
    // The actual pattern is inline, not just a menu entry.
    expect(withConv.system).toContain("@/lib/api/client");

    const noConv = { system: "" };
    const off = await Session.create({
      provider: systemCapturingProvider(noConv),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
    });

    await off.send("go");

    expect(noConv.system).not.toContain("HOW THIS STACK WRITES CODE");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
