/**
 * Harness Proposal (paper §3.3): the SAME fixed model, in a proposer role,
 * turns the mined evidence bundle into K diverse-but-minimal candidate edits.
 * The proposer sees a bounded context — the editable-surface catalog, the
 * evidence bundle, the current overlay (behaviors already promoted), and
 * summaries of prior attempts — never raw execution logs or the held-out
 * split. Each candidate must ground itself in ONE failure pattern and edit a
 * declared surface; anything else drops with an explicit note (no silent caps).
 */
import type { IProvider } from "../inference";
import { extractJson } from "../lib/json";
import { PROPOSAL_SCHEMA, PROPOSAL_SCHEMA_NAME } from "./proposal-schema";
import { isRecord } from "../lib/guards";
import { isEmptyPatch, parseOverlay } from "./overlay";
import type {
  ICandidate,
  IEvidenceBundle,
  IHarnessOverlay,
  IOverlayPatch,
} from "./self-harness.types";

/** Patterns shown to the proposer per round; the rest are noted as dropped. */
const MAX_PATTERNS = 5;
/** A candidate may touch at most this many individual edits — the paper's
 *  minimality constraint, enforced mechanically. */
const MAX_EDITS_PER_CANDIDATE = 3;

const SURFACE_CATALOG = `You may edit ONLY these declared harness surfaces, expressed as a JSON "patch" object (all fields optional):

1. "ttsrRules": array of stream-time rules. Each rule aborts generation when a regex matches the live output and injects corrective guidance on retry.
   Shape: {"name": "kebab-case", "condition": ["regex source", ...], "scope": "content"|"tool-args"|"both", "fileGlobs": ["src/**/*.ts"]?, "guidance": "<=300 chars", "repeatMode": "once"|"cooldown", "repeatGap": number?}

2. "promptBlocks": edits to NAMED system-prompt blocks. Names: "bootstrap" (the lead-with-action instruction), "execution" (the gate-feedback-loop instruction), "verification" (the run-your-hypotheses instruction), "extra" (a free block appended after all built-in guidance).
   Shape: {"<name>": {"mode": "append"|"replace", "text": "..."}}

3. "procedureCards": per-gate-rule repair guidance shown when that rule fails, keyed by the exact rule id (e.g. "TS2307", "no-as").
   Shape: {"<ruleId>": {"what": "...", "bad": "...", "good": "...", "procedure": "step-by-step fix workflow"}}

4. "agentSpecOverrides": bounded overrides of existing subagents (explore, research, verify, review-lens). Only systemPrompt, task, and maxTurns — model is NOT editable.
   Shape: [{"id": "explore", "systemPrompt": "..."?, "task": "..."?, "maxTurns": number?}]

5. "toolOverrides": how an EXISTING tool is offered — reword its description so its purpose or its failure modes are clearer, or stop offering one that the traces show being misused. You cannot ADD a tool: an id naming a tool the harness does not already offer has no effect. Withdrawing a tool the task needs will show up as a lower pass rate and be rejected.
   Shape: [{"id": "<advertised tool name>", "description": "..."?, "enabled": false?}]

NOT editable (do not attempt): the gate/verifier, its strictness or rules, WHICH tools exist, model routing, the control loop.`;

const PROPOSER_SYSTEM = `You are the harness-improvement proposer inside tsforge (Self-Harness loop). A fixed model — you — runs coding tasks under a harness; the harness is the object of improvement, not the model or the verifier.

You receive verifier-grounded failure patterns mined from held-in execution traces. Propose exactly ONE minimal candidate edit that targets ONE pattern's mechanism. Requirements:
- MINIMAL: change only the surface needed for the chosen mechanism (at most ${String(MAX_EDITS_PER_CANDIDATE)} individual edits); preserve unrelated harness behavior.
- GROUNDED: pick a pattern that is concrete, recurrent, and plausibly mitigated by a narrow change to instructions/rules — not one reflecting task difficulty or model capability limits.
- DISTINCT: materially different from the other candidates listed (different pattern, surface, or hypothesis — not a rewording).

Respond with ONLY a JSON object:
{"targetPattern": "<signature of the pattern you target>", "surface": "ttsrRules|promptBlocks|procedureCards|agentSpecOverrides", "expectedEffect": "<one sentence>", "risks": "<one sentence>", "patch": {<the patch object>}}`;

function renderBundle(bundle: IEvidenceBundle, notes: string[]): string {
  const shown = bundle.patterns.slice(0, MAX_PATTERNS);

  if (bundle.patterns.length > shown.length) {
    notes.push(
      `proposer context: dropped ${String(bundle.patterns.length - shown.length)} low-support pattern(s) beyond the top ${String(MAX_PATTERNS)}`
    );
  }

  const blocks = shown.map((p, i) =>
    [
      `Pattern ${String(i + 1)} — signature: ${p.signature} (${String(p.support)} failed run(s): ${p.taskIds.join(", ")})`,
      `  mechanism: ${p.mechanism}`,
      p.verifierEvidence.length > 0
        ? `  verifier evidence (failing gate rules): ${p.verifierEvidence.join(", ")}`
        : "",
      ...p.traceSnippets.map((s) => `  trace: ${s}`),
    ]
      .filter((line) => line.length > 0)
      .join("\n")
  );

  return blocks.join("\n\n");
}

function renderContext(
  bundle: IEvidenceBundle,
  current: IHarnessOverlay,
  priorAttempts: readonly string[],
  soFar: readonly ICandidate[],
  notes: string[]
): string {
  const parts = [
    SURFACE_CATALOG,
    `## Failure patterns (held-in split, ${String(bundle.failedRuns)}/${String(bundle.totalRuns)} runs failed${bundle.slowGreenRuns > 0 ? `, ${String(bundle.slowGreenRuns)} passed but pathologically slow` : ""})\n${renderBundle(bundle, notes)}`,
    `## Current overlay (already-promoted edits — preserve their behavior)\n${JSON.stringify(current, null, 2)}`,
  ];

  if (priorAttempts.length > 0) {
    parts.push(
      `## Previously attempted edits (do not repeat)\n${priorAttempts.map((a) => `- ${a}`).join("\n")}`
    );
  }

  if (soFar.length > 0) {
    parts.push(
      `## Candidates already proposed THIS round (be materially distinct)\n${soFar
        .map(
          (c) =>
            `- targets ${c.audit.targetPattern} via ${c.audit.surface}: ${c.audit.expectedEffect}`
        )
        .join("\n")}`
    );
  }

  return parts.join("\n\n");
}

/** Total individual edits in a patch — the minimality metric. */
function editCount(patch: IOverlayPatch): number {
  return (
    (patch.ttsrRules?.length ?? 0) +
    (patch.agentSpecOverrides?.length ?? 0) +
    (patch.toolOverrides?.length ?? 0) +
    Object.keys(patch.promptBlocks ?? {}).length +
    Object.keys(patch.procedureCards ?? {}).length
  );
}

/** Validate one raw proposer response into a candidate, or a rejection reason. */
function parseCandidate(
  raw: string,
  id: string
): { candidate?: ICandidate; reason?: string } {
  let data: unknown;

  try {
    data = JSON.parse(extractJson(raw));
  } catch {
    return { reason: "unparseable proposer response" };
  }

  if (!isRecord(data) || !isRecord(data.patch)) {
    return { reason: "response lacks a patch object" };
  }

  // Route the raw patch through the overlay validator so a proposed edit obeys
  // exactly the runtime schema; invalid entries drop, and a patch that
  // validates to nothing is rejected (paper: must modify an editable surface).
  const validated = parseOverlay(data.patch);

  if (validated === null) {
    return { reason: "patch is not an object" };
  }

  // Only the surfaces the edit actually touches — empty arrays/objects in the
  // patch would read as "this edit touches everything" in the report diff.
  const patch: IOverlayPatch = {
    ...(validated.ttsrRules.length > 0
      ? { ttsrRules: validated.ttsrRules }
      : {}),
    ...(validated.agentSpecOverrides.length > 0
      ? { agentSpecOverrides: validated.agentSpecOverrides }
      : {}),
    ...(Object.keys(validated.promptBlocks).length > 0
      ? { promptBlocks: validated.promptBlocks }
      : {}),
    ...(Object.keys(validated.procedureCards).length > 0
      ? { procedureCards: validated.procedureCards }
      : {}),
  };

  if (isEmptyPatch(patch)) {
    return { reason: "patch modifies no editable surface after validation" };
  }

  if (editCount(patch) > MAX_EDITS_PER_CANDIDATE) {
    return {
      reason: `patch exceeds the minimality cap (${String(editCount(patch))} edits > ${String(MAX_EDITS_PER_CANDIDATE)})`,
    };
  }

  return {
    candidate: {
      id,
      patch,
      audit: {
        targetPattern:
          typeof data.targetPattern === "string" ? data.targetPattern : "",
        surface: typeof data.surface === "string" ? data.surface : "",
        expectedEffect:
          typeof data.expectedEffect === "string" ? data.expectedEffect : "",
        risks: typeof data.risks === "string" ? data.risks : "",
      },
    },
  };
}

export interface IProposeOptions {
  readonly provider: IProvider;
  readonly width: number;
  readonly current: IHarnessOverlay;
  /** One-line summaries of previously rejected/accepted edits across rounds. */
  readonly priorAttempts?: readonly string[];
  /** Candidate id prefix, e.g. "r2" → r2-c1, r2-c2… */
  readonly idPrefix?: string;
  /** No-silent-caps sink: dropped candidates / truncated context. */
  readonly notes?: string[];
}

/**
 * Generate up to `width` validated candidates. Sequential calls (the primary
 * endpoint is single-connection); each later call sees the earlier candidates
 * so diversity is prompted, not hoped for. A round with zero mineable
 * patterns short-circuits to no candidates.
 */
export async function propose(
  bundle: IEvidenceBundle,
  opts: IProposeOptions
): Promise<ICandidate[]> {
  const notes = opts.notes ?? [];

  if (bundle.patterns.length === 0) {
    notes.push("propose: no failure patterns — nothing to target");

    return [];
  }

  const candidates: ICandidate[] = [];

  for (let i = 0; i < opts.width; i += 1) {
    const id = `${opts.idPrefix ?? "r0"}-c${String(i + 1)}`;
    let content: string;

    try {
      const res = await opts.provider.complete(
        [
          { role: "system", content: PROPOSER_SYSTEM },
          {
            role: "user",
            content: renderContext(
              bundle,
              opts.current,
              opts.priorAttempts ?? [],
              candidates,
              notes
            ),
          },
        ],
        {
          // Mild temperature: K identical greedy calls would defeat the
          // parallel-proposal diversity the paper relies on.
          temperature: 0.7,
          // Shape the decode. An endpoint without guided decoding ignores this
          // and the salvage re-ask below still covers it.
          responseFormat: {
            type: "json_schema",
            name: PROPOSAL_SCHEMA_NAME,
            schema: PROPOSAL_SCHEMA,
          },
        }
      );

      content = res.content;
    } catch (err) {
      notes.push(
        `propose ${id}: call failed (${err instanceof Error ? err.message : String(err)})`
      );
      continue;
    }

    let { candidate, reason } = parseCandidate(content, id);

    // One salvage re-ask on a malformed proposal: show the model exactly why
    // its response was unusable and demand a corrected JSON object. Wasting a
    // full validation slot on a JSON formatting slip starves the loop of
    // measured attempts (observed: 2 of 3 proposals dropped unparsed).
    if (candidate === undefined) {
      try {
        const retry = await opts.provider.complete(
          [
            { role: "system", content: PROPOSER_SYSTEM },
            {
              role: "user",
              content: renderContext(
                bundle,
                opts.current,
                opts.priorAttempts ?? [],
                candidates,
                notes
              ),
            },
            { role: "assistant", content },
            {
              role: "user",
              content: `Your response was unusable: ${reason ?? "invalid"}. Reply again with ONLY the corrected JSON object — same schema, no prose, no code fences.`,
            },
          ],
          {
            temperature: 0,
            responseFormat: {
              type: "json_schema",
              name: PROPOSAL_SCHEMA_NAME,
              schema: PROPOSAL_SCHEMA,
            },
          }
        );

        ({ candidate, reason } = parseCandidate(retry.content, id));
      } catch (err) {
        notes.push(
          `propose ${id}: salvage re-ask failed (${err instanceof Error ? err.message : String(err)})`
        );
      }
    }

    if (candidate === undefined) {
      notes.push(
        `propose ${id}: dropped after salvage re-ask — ${reason ?? "invalid"}`
      );
      continue;
    }

    candidates.push(candidate);
  }

  return candidates;
}
