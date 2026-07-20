import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import {
  conventionGuide,
  conventionTopics,
  topicForRule,
  unseenGuidesForErrors,
} from "../src/loop/conventions";
import { injectFeedback, type ILoopCtx } from "../src/loop/turn";
import type { ILoopState, ILoopEvent } from "../src/loop";
import type { IErrorItem } from "../src/validate";
import { commandGate } from "../src/gate/gate-runner";

describe("convention registry", () => {
  test("every topic has a non-empty guide", () => {
    for (const topic of conventionTopics()) {
      expect(conventionGuide(topic).length).toBeGreaterThan(40);
    }
  });

  test("the no-casts guide teaches a type guard, never a cast", () => {
    const g = conventionGuide("no-casts");

    expect(g).toContain("TYPE GUARD");
    expect(g).toContain("v is St");
  });

  test("component-anatomy points components to src/features (the real boringstack layout)", () => {
    const g = conventionGuide("component-anatomy");

    expect(g).toContain("src/features/<feature>/components/");
    // The dead UI-only-React `src/views` layout must be gone.
    expect(g).not.toContain("src/views/");
  });

  test("data-fetching guide states the apiClient pattern and forbids response.error", () => {
    const g = conventionGuide("data-fetching");

    expect(g).toContain("@/lib/api/client");
    expect(g).toContain("const { data }");
    expect(g).toContain("response.error");
    expect(g).toContain("throwOnError");
  });

  test("data-fetching guide tells the model the gate runs generate:api for it (no manual regen, no file-by-file type chase)", () => {
    const g = conventionGuide("data-fetching");

    // Minimal, unattackable claims only: generate:api is PART OF the gate (a plain fact
    // about the gate command), so the model shouldn't run it by hand or chase client
    // types file-by-file. Deliberately makes NO guarantee about what a passing gate
    // proves (the api-leg && short-circuit + differential suppression make any such
    // guarantee false in edge cases) and NO db:push claim (its exit is swallowed — #60).
    expect(g).toContain("generate:api");
    expect(g).toContain("don't run `generate:api` by hand");
    expect(g).toContain("part of the gate");
    // No overclaim: no "every cycle", no "passing gate proves X", no db:push claim, no
    // stale-client framing, no instruction to run generate:api itself.
    expect(g).not.toContain("every gate cycle");
    expect(g).not.toContain("passing gate");
    expect(g).not.toContain("db:push");
    expect(g).not.toContain("NEVER stale");
    expect(g).not.toContain("then `bun run generate:api`");
  });
});

describe("topicForRule", () => {
  test("maps enforced rule ids (bare and plugin-prefixed) to their topic", () => {
    expect(topicForRule("component-file-purity")).toBe("file-layout");
    expect(topicForRule("tsforge/no-jsx-computation")).toBe("jsx");
    expect(topicForRule("no-restricted-syntax")).toBe("no-casts");
    expect(topicForRule("component-folder-structure")).toBe(
      "component-anatomy"
    );
  });

  test("an unknown rule maps to nothing", () => {
    expect(topicForRule("some-random-rule")).toBeNull();
  });
});

describe("unseenGuidesForErrors (the PUSH dedup)", () => {
  test("returns the guide the FIRST time a rule is hit, then never again", () => {
    const seen = new Set<string>();
    const errors = [{ rule: "tsforge/component-file-purity" }];

    const first = unseenGuidesForErrors(errors, seen);

    expect(first).toHaveLength(1);
    expect(first[0]).toContain("FILE PURITY");

    // Same rule next cycle → already pushed → nothing (no wall of repeats).
    expect(unseenGuidesForErrors(errors, seen)).toHaveLength(0);
  });

  test("one guide per TOPIC even across many errors of that topic", () => {
    const seen = new Set<string>();
    const errors = [
      { rule: "component-folder-structure" },
      { rule: "one-component-per-file" }, // same topic (component-anatomy)
      { rule: "no-restricted-syntax" }, // different topic (no-casts)
    ];

    const guides = unseenGuidesForErrors(errors, seen);

    expect(guides).toHaveLength(2); // component-anatomy + no-casts, not 3
  });

  test("errors with no rule, or unknown rules, contribute nothing", () => {
    const seen = new Set<string>();

    expect(
      unseenGuidesForErrors([{ rule: undefined }, { rule: "unknown" }], seen)
    ).toEqual([]);
  });
});

describe("convention PUSH delivery (the guide actually reaches the model + is observable)", () => {
  function makeCtx(events: ILoopEvent[]): ILoopCtx {
    return {
      task: {
        id: "t",
        intent: "build",
        accept: "true",
        files: [],
        context: [],
      },
      cwd: tmpdir(),
      tsService: null,
      report: (e) => {
        events.push(e);
      },
      messages: [],
      tool: {},
      gate: {
        parse: undefined,
        runner: commandGate(
          {
            id: "t",
            intent: "build",
            accept: "true",
            files: [],
            context: [],
          },
          undefined
        ),
      },
    };
  }

  function freshState(): ILoopState {
    return {
      prevGateErrors: [],
      gateNoProgress: 0,
      bestErrorCount: Number.POSITIVE_INFINITY,
      noNewLow: 0,
      errorAge: new Map(),
      lastGateCount: -1,
      edits: 0,
      regressions: 0,
      ttsrInterrupts: 0,
      steerLevel: 0,
      // These tests cover the boringstack convention PUSH — the backend that ships
      // the library turns it on. A plain build (conventionsEnabled unset) never pushes.
      conventionsEnabled: true,
    };
  }

  const asCastError: IErrorItem = {
    key: "src/x.tsx:1:no-restricted-syntax",
    file: "src/x.tsx",
    rule: "no-restricted-syntax", // → no-casts guide
    message: "L1: No `as` type casts (no-restricted-syntax)",
  };

  test("a gate error maps to a guide that lands in the message SENT to the model", async () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();

    await injectFeedback(ctx, state, [asCastError], [], []);

    // The guide is in the actual user message the model will receive next.
    const sent = ctx.messages.at(-1)?.content ?? "";

    expect(sent).toContain("HOW TO WRITE THIS RIGHT (boringstack)");
    expect(sent).toContain("TYPE GUARD"); // the no-casts guide's teaching
    // …and the push is OBSERVABLE (was silent — you couldn't tell it fired).
    expect(
      events.some((e) => e.kind === "tool" && e.message.includes("📐 pushed"))
    ).toBe(true);
  });

  test("the same topic is pushed only ONCE per run (deduped, not a wall)", async () => {
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = freshState();

    await injectFeedback(ctx, state, [asCastError], [], []);
    await injectFeedback(ctx, state, [asCastError], [], []);

    const pushes = events.filter(
      (e) => e.kind === "tool" && e.message.includes("📐 pushed")
    );

    expect(pushes).toHaveLength(1); // second cycle: already taught, no re-push
    expect(ctx.messages.at(-1)?.content ?? "").not.toContain(
      "HOW TO WRITE THIS RIGHT"
    );
  });

  test("a plain build (conventionsEnabled off) is NEVER pushed boringstack how-to", async () => {
    // Decoupling guarantee: a backend without a convention library gets the gate
    // error + rule docs, but no boringstack-flavored guide injected. Symmetric with
    // pull_conventions being withheld unless the backend opts in.
    const events: ILoopEvent[] = [];
    const ctx = makeCtx(events);
    const state = { ...freshState(), conventionsEnabled: false };

    await injectFeedback(ctx, state, [asCastError], [], []);

    expect(ctx.messages.at(-1)?.content ?? "").not.toContain(
      "HOW TO WRITE THIS RIGHT"
    );
    expect(
      events.some((e) => e.kind === "tool" && e.message.includes("📐 pushed"))
    ).toBe(false);
  });
});
