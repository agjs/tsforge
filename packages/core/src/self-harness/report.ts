/**
 * The human gate: render a self-harness lineage into (a) the final overlay
 * JSON — the PR-able artifact a human reviews and installs — and (b) a
 * markdown evidence report making every transition auditable (paper §3.4:
 * "changed surfaces, split-wise outcomes, proposal summary, and accept/reject
 * decision"). This module never writes to the promoted overlay path itself.
 */
import { isEmptyPatch, overlayPathFor } from "./overlay";
import type {
  IHarnessEval,
  ILineage,
  IRoundRecord,
  IValidationResult,
} from "./self-harness.types";

function passLine(label: string, evaluation: IHarnessEval): string {
  const { heldIn, heldOut } = evaluation;

  return `| ${label} | ${String(heldIn.passed)}/${String(heldIn.runs)} | ${String(heldOut.passed)}/${String(heldOut.runs)} | ${heldIn.avgQuality > 0 ? heldIn.avgQuality.toFixed(1) : "—"} | ${heldOut.avgQuality > 0 ? heldOut.avgQuality.toFixed(1) : "—"} |`;
}

function renderCandidate(result: IValidationResult): string {
  const { candidate } = result;
  const verdict = result.accepted ? "✅ ACCEPTED" : "❌ rejected";
  const lines = [
    `#### ${candidate.id} — ${verdict}`,
    `- **targets:** \`${candidate.audit.targetPattern}\` via **${candidate.audit.surface}**`,
    `- **expected effect:** ${candidate.audit.expectedEffect}`,
    `- **risks:** ${candidate.audit.risks}`,
    `- **outcome:** Δin=${String(result.deltaIn)}, Δho=${String(result.deltaOut)} — ${result.reason}`,
    "```json",
    JSON.stringify(candidate.patch, null, 2),
    "```",
  ];

  return lines.join("\n");
}

function renderRound(round: IRoundRecord): string {
  const parts = [
    `### Round ${String(round.round)}`,
    "",
    "| harness | held-in pass | held-out pass | Q(in) | Q(ho) |",
    "|---|---|---|---|---|",
    passLine(`h_${String(round.round)}`, round.baseline),
    "",
    `**Mined patterns (${String(round.evidence.failedRuns)}/${String(round.evidence.totalRuns)} held-in runs failed):**`,
    ...round.evidence.patterns.map(
      (p) =>
        `- \`${p.signature}\` ×${String(p.support)} (${p.taskIds.join(", ")}) — ${p.mechanism}`
    ),
    "",
  ];

  if (round.candidates.length === 0) {
    parts.push("_No candidates this round._");
  } else {
    parts.push(...round.candidates.map(renderCandidate));
  }

  return parts.join("\n");
}

export interface IReport {
  /** The final overlay as JSON — the artifact a human reviews and installs. */
  readonly overlayJson: string;
  readonly markdown: string;
}

export function emitReport(lineage: ILineage): IReport {
  const overlayJson = `${JSON.stringify(lineage.finalOverlay, null, 2)}\n`;
  const acceptedTotal = lineage.rounds.reduce(
    (acc, r) => acc + r.acceptedIds.length,
    0
  );
  const rejectedTotal = lineage.rounds.reduce(
    (acc, r) => acc + (r.candidates.length - r.acceptedIds.length),
    0
  );
  const installPath = overlayPathFor(lineage.model);

  const md = [
    `# Self-Harness report — ${lineage.model}`,
    "",
    `Held-in: ${lineage.splits.heldIn.join(", ")}`,
    `Held-out: ${lineage.splits.heldOut.join(", ")} _(never shown to the proposer)_`,
    "",
    `Rounds: ${String(lineage.rounds.length)} · accepted: ${String(acceptedTotal)} · rejected: ${String(rejectedTotal)}`,
    "",
    ...lineage.rounds.map(renderRound),
    "",
    "## Final overlay",
    "",
    isEmptyPatch(lineage.finalOverlay)
      ? "_Empty — no edit survived validation. The base harness stands._"
      : [
          "```json",
          overlayJson.trimEnd(),
          "```",
          "",
          `**To install (human decision):** review the overlay above, then write it to \`${installPath}\`. Remove that file to revert to the base harness.`,
        ].join("\n"),
    "",
    ...(lineage.notes.length > 0
      ? [
          "## Notes (dropped/skipped/truncated — nothing is silent)",
          "",
          ...lineage.notes.map((n) => `- ${n}`),
        ]
      : []),
    "",
  ].join("\n");

  return { overlayJson, markdown: md };
}
