import { test, expect } from "bun:test";
import { judge, JUDGE_INPUT_SHAPE } from "../src/eval";
import type { IProvider, IChatMessage } from "../src/inference";

function providerSaying(content: string): IProvider {
  return {
    async complete() {
      return { content, toolCalls: [] };
    },
  };
}

/** A provider that records the messages it was given, for prompt assertions. */
function capturingProvider(): { provider: IProvider; seen: IChatMessage[] } {
  const seen: IChatMessage[] = [];

  return {
    seen,
    provider: {
      async complete(messages) {
        seen.push(...messages);

        return { content: '{"overall":3}', toolCalls: [] };
      },
    },
  };
}

test("parses a JSON quality score from the reviewer", async () => {
  const provider = providerSaying(
    JSON.stringify({
      overall: 4,
      correctness: 5,
      design: 4,
      readability: 3,
      notes: "solid, minor naming nits",
    })
  );

  const s = await judge(provider, { goal: "g", criteria: "c", code: "x" });

  expect(s.overall).toBe(4);
  expect(s.correctness).toBe(5);
  expect(s.readability).toBe(3);
  expect(s.notes).toContain("solid");
  expect(s.scored).toBe(true); // a real, usable score
});

test("an unparseable response is flagged scored:false (no usable signal)", async () => {
  const s = await judge(providerSaying("hmm, looks alright I guess"), {
    goal: "g",
    criteria: "c",
    code: "x",
  });

  // Must be marked unscored so the caller skips the quality loop rather than
  // feeding the generator a nonsense "0/5" critique.
  expect(s.scored).toBe(false);
  expect(s.overall).toBe(0);
  expect(s.notes).toContain("unparseable");
});

test("parseable JSON lacking a valid overall is also flagged scored:false", async () => {
  // Parses fine, but no usable 1–5 overall (missing / out of range → clamped to 0).
  // That's still no signal — must not be treated as a real 0/5.
  const missing = await judge(
    providerSaying('{"design":4,"readability":4,"notes":"ok"}'),
    { goal: "g", criteria: "c", code: "x" }
  );

  expect(missing.scored).toBe(false);
  expect(missing.overall).toBe(0);

  const outOfRange = await judge(providerSaying('{"overall":9,"notes":"ok"}'), {
    goal: "g",
    criteria: "c",
    code: "x",
  });

  expect(outOfRange.scored).toBe(false);
});

test("tolerates a fenced JSON block", async () => {
  const provider = providerSaying(
    'Here is my review:\n```json\n{"overall":2,"correctness":2,"design":2,"readability":2,"notes":"weak"}\n```\n'
  );

  const s = await judge(provider, { goal: "g", criteria: "c", code: "x" });

  expect(s.overall).toBe(2);
});

// Design-rule #2: the evaluator must NEVER see the generator's trace/reasoning.
// JUDGE_INPUT_SHAPE is `Record<keyof IJudgeInput, true>`, so adding a field to
// IJudgeInput forces it to appear here — and this test rejects any trace-ish name.
test("the judge input shape carries NO trace/reasoning fields (ratchet)", () => {
  const keys = Object.keys(JUDGE_INPUT_SHAPE).map((k) => k.toLowerCase());
  const forbidden = [
    "trace",
    "toolcalls",
    "tool_calls",
    "reasoning",
    "thinking",
    "transcript",
    "history",
    "messages",
    "events",
    "steps",
  ];

  for (const bad of forbidden) {
    expect(keys).not.toContain(bad);
  }

  // It IS exactly the artifact-only triple — if this changes, re-audit rule #2.
  expect(keys.sort()).toEqual(["code", "criteria", "goal"]);
});

test("the judge prompt is built only from goal/criteria/code", async () => {
  const { provider, seen } = capturingProvider();

  await judge(provider, {
    goal: "GOAL_SENTINEL",
    criteria: "CRIT_SENTINEL",
    code: "CODE_SENTINEL",
  });

  const user = seen.find((m) => m.role === "user")?.content ?? "";

  expect(user).toContain("GOAL_SENTINEL");
  expect(user).toContain("CRIT_SENTINEL");
  expect(user).toContain("CODE_SENTINEL");
});

test("falls back gracefully on an unparseable response", async () => {
  const s = await judge(providerSaying("no json here"), {
    goal: "g",
    criteria: "c",
    code: "x",
  });

  expect(s.overall).toBe(0);
  expect(s.notes.toLowerCase()).toContain("unparseable");
});
