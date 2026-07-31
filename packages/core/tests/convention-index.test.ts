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
import type { IProvider, IChatMessage } from "../src/inference";
import type { IConventionProvider } from "../src/loop/conventions-provider";
import type { IGate } from "../src/gate/gate-runner";
import type { IValidateResult } from "../src/validate";
import { Session } from "../src/loop";
import { toolsFor } from "../src/loop/turn";
import { buildPullConventionsTool, TOOL_NAME } from "../src/agent";

/** A gate that always reports one error, so the drive loop hits a failure after the model's edit
 *  and fires the reactive convention PUSH. */
const redGate: IGate = {
  run: async (): Promise<IValidateResult> => ({
    passed: false,
    errors: [
      {
        key: "a",
        file: "a.ts",
        line: 1,
        rule: "no-casts",
        message: "no as",
      },
    ],
    output: "",
  }),
};

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

test("Session threads cfg.conventions to the reactive PUSH (real drive loop)", async () => {
  // The Session-wiring proof: a real drive-to-green session — the model makes an edit, the RED gate
  // fires, and the reactive push must inject the INJECTED provider's guide (a sentinel) into the
  // next message the model sees. Deleting session.ts's `ctx.tool.conventions = cfg.conventions`
  // spread makes the push find no provider ⇒ the sentinel never appears ⇒ this fails.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-conv-push-"));

  await Bun.write(join(dir, "a.ts"), "export const x = 1;\n");

  const seen = { sentinel: false };
  let turn = 0;

  const provider: IProvider = {
    async complete(messages: IChatMessage[]) {
      turn += 1;

      if (
        messages.some(
          (m) =>
            typeof m.content === "string" &&
            m.content.includes("PUSH_THREAD_SENTINEL")
        )
      ) {
        seen.sentinel = true;
      }

      if (turn === 1) {
        // An in-scope edit so the drive loop runs the gate (→ RED → reactive push next turn).
        return {
          content: "",
          toolCalls: [
            {
              id: "1",
              name: "edit",
              arguments: {
                file: "a.ts",
                oldString: "const x = 1;",
                newString: "const x = 2;",
              },
            },
          ],
        };
      }

      return { content: "done", toolCalls: [] };
    },
  };

  const fakeConv: IConventionProvider = {
    buildGuides: () => "",
    unseenForErrors: (errors, seenSet) => {
      if (errors.length === 0 || seenSet.has("x")) {
        return [];
      }

      seenSet.add("x");

      return ["PUSH_THREAD_SENTINEL"];
    },
    guide: () => null,
    topics: () => [],
  };

  try {
    const s = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      pullConventions: true,
      conventions: fakeConv,
      gate: redGate,
    });

    await s.send("build it");

    expect(seen.sentinel).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Session threads cfg.conventions into the pull_conventions tool (real dispatch)", async () => {
  // The PULL half through the real dispatcher: the model calls pull_conventions and gets back the
  // INJECTED provider's guide (a sentinel), proving cfg.conventions → ctx.tool.conventions →
  // doPullConventions. Requires pull_conventions to survive the policy layer (classify.ts).
  const dir = await mkdtemp(join(tmpdir(), "tsforge-conv-pull-"));
  const captured: { result: string | null } = { result: null };
  let turn = 0;

  const provider: IProvider = {
    async complete(messages: IChatMessage[]) {
      turn += 1;

      if (turn === 1) {
        return {
          content: "",
          toolCalls: [
            { id: "1", name: "pull_conventions", arguments: { topic: "x" } },
          ],
        };
      }

      const toolMsg = [...messages].reverse().find((m) => m.role === "tool");

      captured.result =
        typeof toolMsg?.content === "string" ? toolMsg.content : null;

      return { content: "done", toolCalls: [] };
    },
  };

  const fakeConv: IConventionProvider = {
    buildGuides: () => "",
    unseenForErrors: () => [],
    guide: () => "TOOL_THREAD_SENTINEL",
    topics: () => ["x"],
  };

  try {
    const s = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      pullConventions: true,
      conventions: fakeConv,
    });

    await s.send("go");

    expect(captured.result).toContain("TOOL_THREAD_SENTINEL");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hallucinated pull_conventions call with pullConventions OFF gets no provider (no withheld-capability leak)", async () => {
  // The provider is threaded into the tool context ONLY when pullConventions is on (the flag that
  // offers the tool). With the flag off, a hallucinated pull_conventions call executes (read-only,
  // policy-allowed) but finds no provider → "not configured", never the injected guides.
  const dir = await mkdtemp(join(tmpdir(), "tsforge-conv-withheld-"));
  const captured: { result: string | null } = { result: null };
  let turn = 0;

  const provider: IProvider = {
    async complete(messages: IChatMessage[]) {
      turn += 1;

      if (turn === 1) {
        return {
          content: "",
          toolCalls: [
            { id: "1", name: "pull_conventions", arguments: { topic: "x" } },
          ],
        };
      }

      const toolMsg = [...messages].reverse().find((m) => m.role === "tool");

      captured.result =
        typeof toolMsg?.content === "string" ? toolMsg.content : null;

      return { content: "done", toolCalls: [] };
    },
  };

  try {
    const s = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      // pullConventions OFF — but a provider is still on the config.
      conventions: {
        buildGuides: () => "",
        unseenForErrors: () => [],
        guide: () => "TOOL_THREAD_SENTINEL",
        topics: () => ["x"],
      },
    });

    await s.send("go");

    expect(captured.result ?? "").not.toContain("TOOL_THREAD_SENTINEL");
    expect(captured.result ?? "").toContain("no convention library");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The pull_conventions tool no longer carries a hardcoded topic enum (topics come from the
// injected provider at runtime, listed in the front-loaded guides) — so the old enum↔registry
// duplicate is gone. What still matters: every design-system topic the guides added is present
// in the runtime registry, so it's actually PULLABLE via the provider.
test("the design-system topics are in the convention registry (pullable)", () => {
  const registry = new Set<string>(conventionTopics());

  for (const topic of [
    "design-tokens",
    "theming",
    "responsive",
    "accessibility",
    "components-ui",
  ]) {
    expect(registry.has(topic)).toBe(true);
  }
});

// The pull_conventions topic enum is now built AT OFFER TIME from whatever topics are passed —
// it is NOT a literal baked into core. These pin that contract: the enum mirrors the injected
// topics exactly (any list, not a hardcoded BoringStack one), and an empty provider degrades to
// a free-form string rather than an empty/illegal enum.
test("buildPullConventionsTool builds the topic enum from the injected topics (no core literal)", () => {
  // Arbitrary topics — proves the enum is whatever you inject, so core carries no topic literal.
  const arbitrary = buildPullConventionsTool(["alpha", "beta"]);

  expect(arbitrary.function.name).toBe(TOOL_NAME.pullConventions);
  expect(arbitrary.function.parameters.properties.topic.enum).toEqual([
    "alpha",
    "beta",
  ]);

  // With the real BoringStack topics, the enum equals the provider's registry — the only place
  // the concrete topic list lives is the adapter's provider, not this tool.
  const real = buildPullConventionsTool(boringstackConventionProvider.topics());

  expect(real.function.parameters.properties.topic.enum).toEqual([
    ...boringstackConventionProvider.topics(),
  ]);
});

test("buildPullConventionsTool omits the enum for an empty provider (free-form fallback)", () => {
  const tool = buildPullConventionsTool([]);
  const { topic } = tool.function.parameters.properties;

  expect(topic.type).toBe("string");
  expect(topic.enum).toBeUndefined();
});

// The offer path (session → toolsFor) must PUBLISH the provider's topics in the advertised tool
// schema — the model sees exactly the pullable topics, and only when the capability is offered.
test("toolsFor publishes the injected topics as the pull_conventions enum when conventions are offered", () => {
  const offered = toolsFor(false, {}, true, false, false, ["x", "y"]);

  // The advertised tool is byte-equal to building it directly with those topics — the offer
  // path threaded the injected topics straight into the published schema.
  expect(offered).toContainEqual(buildPullConventionsTool(["x", "y"]));

  // Capability off ⇒ the tool isn't advertised at all (no topic surface to leak).
  const withheld = toolsFor(false, {}, false, false, false, ["x", "y"]);

  expect(
    withheld.find((t) => t.function.name === TOOL_NAME.pullConventions)
  ).toBeUndefined();
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
