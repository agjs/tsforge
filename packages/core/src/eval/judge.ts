import type { IProvider } from "../inference";
import { isRecord } from "../lib/guards";
import { extractJson } from "../lib/json";

export interface IJudgeInput {
  goal: string;
  criteria: string;
  code: string;
}

/** A quality score (1–5 per dimension) from an LLM reviewer — what the gate can't see. */
export interface IJudgeScore {
  overall: number;
  correctness: number;
  design: number;
  readability: number;
  notes: string;
}

/**
 * Score a green solution on quality dimensions the deterministic gate can't
 * judge. Provider-agnostic: point it at a flagship model to measure the local
 * model's gap to flagship quality.
 */
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
