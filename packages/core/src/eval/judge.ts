import type { IJudgeInput, IJudgeScore } from "./eval.types";
import type { IProvider } from "../inference";
import { isRecord } from "../lib/guards";
import { extractJson } from "../lib/json";

/**
 * Score a green solution on quality dimensions the deterministic gate can't
 * judge. Provider-agnostic: point it at a flagship model to measure the local
 * model's gap to flagship quality.
 */
/**
 * Every field the quality judge is allowed to see — built from the BUILT ARTIFACT
 * only (goal, acceptance criteria, code), never the generator's tool trace,
 * reasoning, or message history. This is design-rule #2 from the long-running-agent
 * workshop: the evaluator must not see HOW the code was produced, only WHAT was
 * produced, or it can be talked into approving by a persuasive trace.
 *
 * Typed `Record<keyof IJudgeInput, true>` so the list is FORCED to track the
 * interface: adding a field to IJudgeInput is a compile error until it's listed
 * here, where the trace-blindness test (judge.test.ts) rejects any trace-ish name.
 * That makes the rule a ratchet, not a comment.
 */
export const JUDGE_INPUT_SHAPE: Record<keyof IJudgeInput, true> = {
  goal: true,
  criteria: true,
  code: true,
};

const SYSTEM =
  "You are a senior TypeScript reviewer. Score the solution 1–5 on each of: " +
  "correctness/robustness (beyond the given tests), design, and readability/idiomatic TS. " +
  'Respond with ONLY a JSON object: {"overall":1-5,"correctness":1-5,"design":1-5,"readability":1-5,"notes":"<one sentence>"}.';

const UNPARSEABLE: IJudgeScore = {
  overall: 0,
  correctness: 0,
  design: 0,
  readability: 0,
  notes: "unparseable judge response",
};

export async function judge(
  provider: IProvider,
  input: IJudgeInput
): Promise<IJudgeScore> {
  const res = await provider.complete(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Goal: ${input.goal}\n\nAcceptance criteria:\n${input.criteria}\n\nSolution:\n${input.code}`,
      },
    ],
    { temperature: 0 }
  );

  let data: unknown;

  try {
    data = JSON.parse(extractJson(res.content));
  } catch {
    return UNPARSEABLE;
  }

  if (!isRecord(data)) {
    return UNPARSEABLE;
  }

  return {
    overall: clampScore(data.overall),
    correctness: clampScore(data.correctness),
    design: clampScore(data.design),
    readability: clampScore(data.readability),
    notes: typeof data.notes === "string" ? data.notes : "",
  };
}

function clampScore(value: unknown): number {
  return typeof value === "number" && value >= 1 && value <= 5 ? value : 0;
}
