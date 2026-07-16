import { isRecord } from "../lib/guards";

/** The fixed vocabulary a diagnoser must map a parked/failed build to. Grounded
 *  in the observed park modes so the panel's votes are comparable and a
 *  consensus is computable — free-text root causes never agree on a locus. */
export const FAILURE_CATEGORIES = [
  "gate-parity", // fast/feature gate != final acceptance; latent errors surface late
  "near-green-oscillation", // reaches ~green then thrashes; loop never freezes the good state
  "scaffold-infra", // scaffold/boot/docker/env failure, not the model's code
  "wrong-idiom", // model used a stack-divergent pattern (e.g. raw fetch, res.json()->any)
  "scope-freeze", // a frozen/locked file carries errors a later feature cannot edit
  "prompt-contradiction", // the harness handed the model conflicting instructions
  "other",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export type Confidence = "high" | "medium" | "low";

export interface IDiagnosis {
  reviewerId: string;
  category: FailureCategory;
  confidence: Confidence;
  rootCause: string;
  suggestedFix: string;
}

export interface IDiagnoseRequest {
  domain: string;
  parkReason: string;
  turnsSummary: string;
  logSlice: string;
  sliceNote: string;
}

const CATEGORY_HELP = [
  "gate-parity: the fast/per-feature gate differs from final acceptance, so latent errors (e.g. res.json()->any, prettier) surface only at the end when the file is already frozen.",
  "near-green-oscillation: the loop reaches ~1-2 errors then thrashes/regresses, never freezing the good state.",
  "scaffold-infra: scaffold, boot, docker, or environment failure — not the model's code.",
  "wrong-idiom: the model used a stack-divergent pattern (raw fetch instead of the api client, unchecked res.json(), etc.).",
  "scope-freeze: a frozen/locked file carries errors that a later feature is not allowed to edit.",
  "prompt-contradiction: the harness gave the model conflicting instructions (stale scope, command policy, schema library).",
  "other: none of the above fits; explain in rootCause.",
].join("\n");

export const DIAGNOSE_SYSTEM_PROMPT = [
  "You are an independent, skeptical build-failure analyst for an autonomous TypeScript coding harness.",
  "You are given a slice of a build transcript for a run that PARKED or FAILED.",
  "Identify the SINGLE most likely root-cause category and the highest-value HARNESS fix (not a fix to the generated app).",
  "Base your judgement on evidence in the slice; if the slice is a summary, say so in your reasoning and lower confidence.",
  "Respond with ONE JSON object and nothing else:",
  '{ "category": one of the categories below,',
  '  "confidence": "high"|"medium"|"low",',
  '  "rootCause": string (cite the evidence),',
  '  "suggestedFix": string (a concrete change to the harness) }',
  "",
  "Categories:",
  CATEGORY_HELP,
].join("\n");

const CATEGORY_SET: ReadonlySet<string> = new Set(FAILURE_CATEGORIES);

function isCategory(v: unknown): v is FailureCategory {
  return typeof v === "string" && CATEGORY_SET.has(v);
}

function isConfidence(v: unknown): v is Confidence {
  return v === "high" || v === "medium" || v === "low";
}

/** Validate a reviewer's raw JSON into an IDiagnosis. Returns null on ANY
 *  malformation — the caller records that reviewer as errored, never as a vote,
 *  so a parse failure can't skew the consensus. */
export function parseDiagnosis(
  reviewerId: string,
  raw: unknown
): IDiagnosis | null {
  if (
    !isRecord(raw) ||
    !isCategory(raw.category) ||
    !isConfidence(raw.confidence) ||
    typeof raw.rootCause !== "string" ||
    typeof raw.suggestedFix !== "string"
  ) {
    return null;
  }

  return {
    reviewerId,
    category: raw.category,
    confidence: raw.confidence,
    rootCause: raw.rootCause,
    suggestedFix: raw.suggestedFix,
  };
}

export function renderDiagnosePrompt(req: IDiagnoseRequest): string {
  return [
    `Domain: ${req.domain}`,
    `Park/fail reason: ${req.parkReason}`,
    `Turns: ${req.turnsSummary}`,
    `Transcript note: ${req.sliceNote}`,
    "",
    "--- transcript slice ---",
    req.logSlice,
    "--- end slice ---",
  ].join("\n");
}
