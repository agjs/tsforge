import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IProvider } from "../../inference";
import { isRecord } from "../../lib/guards";
import { extractJson } from "../../lib/json";
import { greenfieldDir } from "./state";
import type { IFeature } from "./greenfield.types";

/**
 * Pre-build contract negotiation (EXPERIMENTAL — gated by TSFORGE_CONTRACT, OFF by
 * default; the workshop itself flagged this as unproven). Before building a
 * feature, the generator proposes "I'll build X, verified by Y" and the evaluator
 * pushes back until they agree. The agreed contract then anchors the build, so the
 * generator implements against a checked plan rather than raw prose.
 *
 * The evaluator sees ONLY the proposal text and the feature description — never the
 * generator's reasoning or tool trace (design-rule #2), so it judges the plan, not
 * the persuasion behind it.
 */

/** Whether contract negotiation is enabled (opt-in env flag). */
export function contractEnabled(): boolean {
  const flag = process.env.TSFORGE_CONTRACT;

  return flag !== undefined && flag !== "" && flag !== "0" && flag !== "false";
}

export interface IContractTurn {
  role: "generator" | "evaluator";
  content: string;
}

export interface IContractResult {
  /** The evaluator accepted the latest proposal. */
  agreed: boolean;
  /** Negotiation rounds consumed. */
  rounds: number;
  /** The final proposed contract text (agreed or not). */
  contract: string;
  transcript: IContractTurn[];
}

/** The evaluator's verdict on one proposal. */
export interface IObjection {
  agreed: boolean;
  notes: string;
}

const GENERATOR_SYSTEM =
  "You are the implementer. Propose a SHORT build contract for the ONE feature " +
  "given: what you will build and exactly how it will be verified (gate command " +
  "and/or browser steps). If given objections, revise the contract to address " +
  "them. Respond with ONLY the contract text (no preamble).";

const EVALUATOR_SYSTEM =
  "You are a skeptical reviewer judging a build CONTRACT (a plan), not code. You " +
  "see only the feature and the proposed contract — never how it will be built. " +
  "Accept ONLY if the contract is concrete and its verification actually proves " +
  "the feature. Default to objecting when it's vague or under-verified. Respond " +
  'with ONLY JSON: {"agreed":true|false,"objections":"<one sentence>"}.';

/** Parse the evaluator's verdict; an unparseable response is "not agreed" (fail
 *  closed — a contract isn't agreed unless the evaluator clearly says so). */
export function parseObjection(raw: string): IObjection {
  let data: unknown;

  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    return { agreed: false, notes: "unparseable evaluator response" };
  }

  if (!isRecord(data)) {
    return { agreed: false, notes: "unparseable evaluator response" };
  }

  return {
    agreed: data.agreed === true,
    notes: typeof data.objections === "string" ? data.objections : "",
  };
}

async function propose(
  generator: IProvider,
  feature: IFeature,
  objections: string,
  previousContract: string
): Promise<string> {
  // The provider call is stateless, so a revision must be shown its OWN prior
  // proposal (plus the objection) — otherwise it "revises" from scratch and the
  // negotiation can't converge.
  const ask =
    objections.length > 0
      ? `Feature: ${feature.desc}\n\nYour previous contract:\n${previousContract}\n\nThe reviewer objected: ${objections}\nRevise the contract to address the objection.`
      : `Feature: ${feature.desc}\n\nPropose the build contract.`;
  const res = await generator.complete(
    [
      { role: "system", content: GENERATOR_SYSTEM },
      { role: "user", content: ask },
    ],
    { temperature: 0 }
  );

  return res.content.trim();
}

async function review(
  evaluator: IProvider,
  feature: IFeature,
  contract: string
): Promise<IObjection> {
  const res = await evaluator.complete(
    [
      { role: "system", content: EVALUATOR_SYSTEM },
      {
        role: "user",
        content: `Feature: ${feature.desc}\n\nProposed contract:\n${contract}`,
      },
    ],
    { temperature: 0 }
  );

  return parseObjection(res.content);
}

/**
 * Run the propose↔object loop until the evaluator agrees or `maxRounds` is hit.
 * Returns the final contract and whether it was agreed. Both models are injected;
 * the evaluator only ever sees proposal text (rule #2).
 */
export async function negotiateContract(
  generator: IProvider,
  evaluator: IProvider,
  feature: IFeature,
  maxRounds = 3
): Promise<IContractResult> {
  const transcript: IContractTurn[] = [];
  let objections = "";
  let contract = "";

  for (let round = 1; round <= maxRounds; round += 1) {
    contract = await propose(generator, feature, objections, contract);
    transcript.push({ role: "generator", content: contract });

    const verdict = await review(evaluator, feature, contract);

    transcript.push({
      role: "evaluator",
      content: verdict.agreed ? "agreed" : verdict.notes,
    });

    if (verdict.agreed) {
      return { agreed: true, rounds: round, contract, transcript };
    }

    objections = verdict.notes;
  }

  return { agreed: false, rounds: maxRounds, contract, transcript };
}

/** Persist a negotiation to `.tsforge/greenfield/contracts/<feature-id>.md` for
 *  later inspection (the workshop's "leave the negotiation on disk"). */
export async function writeContract(
  cwd: string,
  feature: IFeature,
  result: IContractResult
): Promise<void> {
  const dir = join(greenfieldDir(cwd), "contracts");

  await mkdir(dir, { recursive: true });

  const body = [
    `# Contract: ${feature.id}`,
    "",
    `Feature: ${feature.desc}`,
    `Status: ${result.agreed ? "agreed" : "not agreed"} (after ${result.rounds} round(s))`,
    "",
    "## Transcript",
    "",
    ...result.transcript.map((t) => `### ${t.role}\n\n${t.content}\n`),
  ].join("\n");

  await writeFile(join(dir, `${feature.id}.md`), `${body}\n`);
}
