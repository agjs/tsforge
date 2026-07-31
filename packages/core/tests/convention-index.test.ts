import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConventionGuides,
  conventionGuide,
  conventionTopics,
  topicForRule,
  boringstackConventionProvider,
} from "../src/loop/conventions";
import { PULL_CONVENTIONS_TOOL } from "../src/agent/agent.constants";
import type { IProvider, IChatMessage } from "../src/inference";
import type { IConventionProvider } from "../src/loop/conventions-provider";
import { Session } from "../src/loop";

/** A minimal fake convention provider returning fixed guide text (the rest of the seam
 *  surface is stubbed — these tests only exercise front-loading). */
const fakeConventions = (guides: string): IConventionProvider => ({
  buildGuides: () => guides,
  unseenForErrors: () => [],
  guide: () => null,
  topics: () => [],
});

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
      conventions: boringstackConventionProvider,
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

test("front-loaded guides come from the INJECTED provider, not a static import", async () => {
  // Locks the WS1a seam: with pullConventions on but NO provider injected, the guides must be
  // ABSENT. A revert to session.ts importing buildConventionGuides directly would re-inject the
  // BoringStack text here and fail — proving the core no longer sources the content itself.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-conv-seam-"));

  try {
    const cap = { system: "" };
    const s = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      pullConventions: true,
    });

    await s.send("go");

    expect(cap.system).not.toContain("HOW THIS STACK WRITES CODE");
    expect(cap.system).not.toContain("@/lib/api/client");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the INJECTED provider's guide content reaches the prompt — not a static import", async () => {
  // The decisive seam test: a FAKE provider returns a sentinel. If session.ts sourced the guides
  // itself (static import) the sentinel would be ABSENT and the BoringStack text PRESENT. So we
  // assert the sentinel IS present and the real BoringStack lib is NOT — content is injected.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-conv-inject-"));

  try {
    const cap = { system: "" };
    const s = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      pullConventions: true,
      conventions: fakeConventions("FAKE_GUIDE_SENTINEL_9Z"),
    });

    await s.send("go");

    expect(cap.system).toContain("FAKE_GUIDE_SENTINEL_9Z");
    expect(cap.system).not.toContain("HOW THIS STACK WRITES CODE");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the pullConventions gate still governs — a provider WITHOUT the flag does not front-load", async () => {
  // Independently verifies the OTHER half: provider present, but pullConventions omitted ⇒ no
  // front-load. Guards against a regression to gating on provider-presence alone.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-conv-gate-"));

  try {
    const cap = { system: "" };
    const s = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      conventions: fakeConventions("FAKE_GUIDE_SENTINEL_9Z"),
    });

    await s.send("go");

    expect(cap.system).not.toContain("FAKE_GUIDE_SENTINEL_9Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The pull_conventions tool enum is a hand-maintained duplicate of TOPICS — this locks it to
// conventionTopics() so a new topic (or a dropped one, like data-fetching was) can't silently
// diverge, leaving a guide the model can't actually pull.
test("PULL_CONVENTIONS_TOOL enum stays in sync with conventionTopics()", () => {
  const enumTopics =
    PULL_CONVENTIONS_TOOL.function.parameters.properties.topic.enum;

  expect([...enumTopics].sort()).toEqual([...conventionTopics()].sort());
});

// Explicit, diff-visible guard for the 5 design-system topics this change added: each must be
// pullable — present in BOTH the runtime guide registry and the hand-maintained pull-tool enum —
// so validate can't stay green while the tool schema and registry diverge for these topics.
test("the new design-system topics are in both the guide registry and the pull enum", () => {
  const enumTopics =
    PULL_CONVENTIONS_TOOL.function.parameters.properties.topic.enum;
  const registry = conventionTopics();

  for (const topic of [
    "design-tokens",
    "theming",
    "responsive",
    "accessibility",
    "components-ui",
  ]) {
    // A Set<string> membership test compares the string cleanly against the typed
    // ConventionTopic[] / enum tuple — no cast, and eslint won't rewrite it into a
    // type-narrowing `.includes()` (which fails typecheck: string vs the topic union).
    expect(new Set<string>(registry).has(topic)).toBe(true);
    expect(new Set<string>(enumTopics).has(topic)).toBe(true);
  }
});

// The STATE guide must NOT tell the model to use raw fetch (it contradicts DATA-FETCHING's
// fetch ban) — the aggregate front-load test can't catch this because the data-fetching guide
// separately contains the api-client string.
test("the STATE guide routes server data through the api-client, not raw fetch", () => {
  const state = conventionGuide("state");

  expect(state).toContain("api-client");
  expect(state).not.toContain("react-query/fetch");
});

// The lint-gotchas guide targets the strict rules a fresh feature trips most (measured live):
// await-thenable, no-confusing-void-expression, no-error-stringify, no-duplicate-string.
test("the lint-gotchas guide covers the top strict-lint offenders", () => {
  const g = conventionGuide("lint-gotchas");

  expect(g).toContain("void expression");
  expect(g).toContain("stringify an error");
  expect(g).toContain("repeated string literals");
  // await-thenable and no-floating-promises are OPPOSITE rules — the guide must teach BOTH
  // directions (add await for a floating promise; DROP await on a non-promise), not conflate them.
  expect(g).toContain("no-floating-promises");
  expect(g).toContain("await-thenable");
  expect(g).toContain("drop the `await`");
});

// Lock the rule→lint-gotchas mapping so unseenGuidesForErrors re-injects this guide on exactly
// these rules (and a renamed/removed rule fails the test rather than silently un-mapping).
test("the strict-lint rules map to the lint-gotchas guide", () => {
  for (const rule of [
    "await-thenable",
    "no-floating-promises",
    "no-confusing-void-expression",
    "no-error-stringify",
    "no-duplicate-string",
  ]) {
    expect(topicForRule(rule)).toBe("lint-gotchas");
  }
});

// Spec 1A — the design-system guides codify BoringStack's existing tokens/ShadCN/theming/responsive/
// a11y so the model leans on them instead of reinventing. Lock the load-bearing content of each so a
// future edit can't hollow a guide out.
test("the design-system guides carry their load-bearing rules", () => {
  const tokens = conventionGuide("design-tokens");

  expect(tokens).toContain("NEVER hardcode a color");
  expect(tokens).toContain("text-muted-foreground");

  const theming = conventionGuide("theming");

  expect(theming).toContain("data-theme");
  expect(theming).toContain("dark:"); // teaches that dark: variants are banned

  const responsive = conventionGuide("responsive");

  expect(responsive).toContain("Mobile-first");
  expect(responsive).toContain("Sheet");

  const a11y = conventionGuide("accessibility");

  expect(a11y).toContain("aria-label");
  expect(a11y).toContain("aria-hidden");
  expect(a11y).toContain("jsx-a11y");

  const ui = conventionGuide("components-ui");

  expect(ui).toContain("@/components/ui/");
  expect(ui).toContain("cn(");
});

// Accessibility is the one design-system topic with a reactive rule mapping: the jsx-a11y rules the
// gate runs as ERRORS must route to the accessibility guide (bare names, jsx-a11y/ prefix stripped),
// so unseenGuidesForErrors pushes it the moment the model trips one.
test("jsx-a11y rules map to the accessibility guide", () => {
  for (const rule of [
    "jsx-a11y/no-static-element-interactions",
    "jsx-a11y/click-events-have-key-events",
    "jsx-a11y/label-has-associated-control",
    "jsx-a11y/aria-role",
  ]) {
    expect(topicForRule(rule)).toBe("accessibility");
  }
});
