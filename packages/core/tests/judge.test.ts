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

test("an unparseable response from a SUCCESSFUL call scores at the floor", async () => {
  // CHANGED, deliberately. This used to be scored:false so the caller skipped
  // the quality loop rather than acting on a nonsense 0/5 — sensible when the
  // judge was only a report. It is now an acceptance guard, and skipping is a
  // PASS: candidate code sits in the judge's prompt and can ask the model to
  // reply with prose, which would switch the guard off from inside the artifact
  // being guarded.
  //
  // Flooring is safe as well as correct: the guard compares candidate against
  // baseline, so a merely flaky judge floors both sides and nothing fires. It
  // bites only when the CANDIDATE's code makes the judge unusable and the
  // baseline's does not — the attack, not the weather.
  const s = await judge(providerSaying("hmm, looks alright I guess"), {
    goal: "g",
    criteria: "c",
    code: "x",
  });

  // `scored` stays FALSE — there is no verdict for the improvement loop to act
  // on. What changed is that the acceptance guard no longer reads `scored`: it
  // reads `outcome`, and floors anything the candidate could have provoked.
  expect(s.scored).toBe(false);
  expect(s.outcome).toBe("unusable");
});

test("parseable JSON lacking a valid overall also scores at the floor", async () => {
  // Same reasoning as above, and the third door into the same bypass: asking the
  // model for an out-of-range number is no harder than asking it for prose.
  // Every route out of a SUCCESSFUL call scores; only a failed call may return
  // no signal.
  const missing = await judge(
    providerSaying('{"design":4,"readability":4,"notes":"ok"}'),
    { goal: "g", criteria: "c", code: "x" }
  );

  expect(missing.scored).toBe(false);
  expect(missing.outcome).toBe("unusable");

  const outOfRange = await judge(providerSaying('{"overall":9,"notes":"ok"}'), {
    goal: "g",
    criteria: "c",
    code: "x",
  });

  expect(outOfRange.outcome).toBe("unusable");
});

test("a judge provider that throws is no-signal, not a crash", async () => {
  // Non-2xx / timeout / connection error from the judge endpoint must not bubble
  // out of the best-effort quality pass — it's treated as no usable signal.
  const throwing: IProvider = {
    async complete() {
      throw new Error("503 from judge endpoint");
    },
  };

  const s = await judge(throwing, { goal: "g", criteria: "c", code: "x" });

  expect(s.scored).toBe(false);
  expect(s.overall).toBe(0);
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
  // Graceful still means "does not throw and does not invent a score" — but the
  // floor, not zero-and-unscored: unscored is a skipped acceptance guard, and
  // the judge's prompt contains candidate code that could ask for exactly this.
  const s = await judge(providerSaying("no json here"), {
    goal: "g",
    criteria: "c",
    code: "x",
  });

  expect(s.scored).toBe(false);
  expect(s.outcome).toBe("unusable");
  expect(s.notes.toLowerCase()).toContain("unusable");
});
