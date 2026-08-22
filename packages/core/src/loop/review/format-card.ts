import { STYLE, paint, GLYPH } from "../../render";
import { wrapToWidth } from "../../render/ansi";
import { displayWidth } from "../../render/width";
import type { IReviewReport, IVerifiedFinding, Severity } from "./review.types";

/** Findings shown worst-first (matches the plain formatReport ordering). */
const SEVERITY_RANK: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** Per-severity badge label + SGR code (badge is the only heavily-colored span). */
function severityStyle(sev: Severity): { label: string; code: string } {
  if (sev === "error") {
    return { label: "ERROR", code: STYLE.red + STYLE.bold };
  }

  if (sev === "warning") {
    return { label: "WARN", code: STYLE.yellow + STYLE.bold };
  }

  return { label: "INFO", code: STYLE.dim };
}

/** Wrap `text` to `width` and paint EACH resulting line (SGR must re-open per line
 *  — the pane wraps logical lines independently, so a code opened on line 1 would
 *  not carry to line 2). `first`/`cont` are the (uncolored) indent prefixes. */
function wrapPainted(
  text: string,
  width: number,
  code: string,
  color: boolean,
  first: string,
  cont: string
): string[] {
  const budget = Math.max(1, width - Math.max(first.length, cont.length));

  return wrapToWidth(text, budget).map((line, i) =>
    paint(`${i === 0 ? first : cont}${line}`, code, color)
  );
}

function renderFinding(
  f: IVerifiedFinding,
  width: number,
  color: boolean
): string[] {
  const { label, code } = severityStyle(f.severity);
  const badge = paint(`${GLYPH.info} ${label}`, code, color);
  const loc = `${f.file}:${String(f.line)}`;
  const where = paint(loc, STYLE.brandLight + STYLE.bold, color);
  // Header: badge + file:line, plus the [lens] tag only when it still fits (it's
  // decorative). The pane wraps the header if a path alone exceeds the width.
  const headPlain = `${GLYPH.info} ${label} ${loc}`;
  const lensTag = `[${f.lens}]`;
  const withLens = displayWidth(headPlain) + 1 + displayWidth(lensTag) <= width;
  const header = withLens
    ? `${badge} ${where} ${paint(lensTag, STYLE.dim, color)}`
    : `${badge} ${where}`;
  const lines = [header];

  // The claim reads in the terminal's default color (the headline you scan).
  lines.push(...wrapPainted(f.claim, width, "", color, "  ", "  "));

  // The reasoning is dim, led by a → on the first row.
  if (f.reason.length > 0) {
    lines.push(
      ...wrapPainted(f.reason, width, STYLE.dim, color, "  → ", "    ")
    );
  }

  if (f.suggestedFix !== undefined) {
    lines.push(
      ...wrapPainted(
        f.suggestedFix,
        width,
        STYLE.dim,
        color,
        "  fix: ",
        "       "
      )
    );
  }

  return lines;
}

/** Gate-aware note — mirrors formatReport's, in dim. Renders even with zero
 *  findings. (The agentic reviewer reads the whole change with no file cap or diff
 *  truncation, so there are no coverage/truncation notes to show.) */
function noteLines(report: IReviewReport, color: boolean): string[] {
  const lines: string[] = [];
  const failed = report.failedReviewers ?? [];

  if (failed.length > 0) {
    lines.push(
      paint(
        `(${String(failed.length)} reviewer(s) failed: ${failed.join(", ")})`,
        STYLE.yellow,
        color
      )
    );
  }

  const gateRules = report.gateFailingRules ?? [];

  if (gateRules.length > 0) {
    lines.push(
      paint(
        `(gate-aware: skipped ${String(gateRules.length)} failing gate rule(s) the gate already covers)`,
        STYLE.dim,
        color
      )
    );
  }

  return lines;
}

/**
 * Render a review report as a colored, width-wrapped block for the interactive
 * TUI (the plain, CI-parseable {@link formatReport} stays for headless/CLI). Emits
 * logical lines with per-line SGR so the pane's scrollback reflow keeps color and
 * width correct. Never overflows: every body line is wrapped to `columns`.
 */
export function formatReviewCard(
  report: IReviewReport,
  columns: number,
  color: boolean
): string {
  const width = Math.max(20, columns);

  if (report.changedFiles.length === 0) {
    return paint("No changed files to review.", STYLE.dim, color);
  }

  const reviewed = report.changedFiles.length;
  const notes = noteLines(report, color);

  if (report.findings.length === 0) {
    const head = paint(
      `${GLYPH.done} Review — no issues across ${String(reviewed)} file(s)`,
      STYLE.green + STYLE.bold,
      color
    );
    const sub = paint(
      `${String(report.rejected)} candidate(s) rejected on verification`,
      STYLE.dim,
      color
    );

    return [head, `  ${sub}`, ...notes].join("\n");
  }

  const head = paint(
    `${GLYPH.warn} Review — ${String(report.findings.length)} finding(s) across ${String(reviewed)} file(s)`,
    STYLE.yellow + STYLE.bold,
    color
  );
  const sub = paint(
    `${String(report.rejected)} rejected on verification`,
    STYLE.dim,
    color
  );
  const sorted = [...report.findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
  const blocks = sorted.map((f) => renderFinding(f, width, color).join("\n"));

  return [head, `  ${sub}`, ...notes, "", blocks.join("\n\n")].join("\n");
}
