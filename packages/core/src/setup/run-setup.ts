import { scanRepo, recommendConventions } from "../infer-rules/scan";
import type { IConventions } from "../infer-rules/conventions.types";
import type { IScanReport } from "../infer-rules/scan.types";
import { runWizard } from "../render/wizard";
import {
  buildSteps,
  configPreview,
  nonDefaultConventions,
  selectionsToConventions,
} from "./wizard-flow";
import { writeSetupConfig } from "./write-config";
import type { ISetupConfig } from "./setup.types";

export interface IRunSetupOptions {
  readonly cwd: string;
  readonly yes: boolean;
  readonly color: boolean;
  /** Defaults to process.stdin/out TTY detection; injectable for tests. */
  readonly interactive?: boolean;
  readonly out?: (s: string) => void;
}

const SAFETY_NOTE =
  "Safety rules (no `any`/`as`/`!`, complexity cap, `===`) are NEVER weakened by setup.";

function setupFor(conventions: IConventions): ISetupConfig {
  // ALWAYS carry a conventions block (possibly empty) so the writer replaces or
  // removes any prior block — re-running setup re-decides all four keys, and the
  // written file always matches the choices the overview showed.
  return { conventions: nonDefaultConventions(conventions) };
}

/** Write the chosen conventions + evidence and print a calm summary. Returns the
 *  process exit code. */
async function applyAndReport(
  opts: IRunSetupOptions,
  conventions: IConventions,
  report: IScanReport,
  write: (s: string) => void
): Promise<number> {
  const result = await writeSetupConfig(
    opts.cwd,
    setupFor(conventions),
    report
  );

  if (!result.ok) {
    if (result.reason === "invalid-existing-json") {
      write(
        `\nExisting tsforge.config.json is invalid JSON (${result.error}). Fix or remove it, then re-run.\n`
      );
    } else {
      write(`\nCould not write config: ${result.error}\n`);
    }

    return 1;
  }

  write(
    `\n✓ Wrote ${result.path}. ${SAFETY_NOTE}\n` +
      `  Evidence: ${result.evidencePath ?? "(none)"}\n` +
      `  Tip: run /map to prime tsforge on this repo.\n`
  );

  return 0;
}

/** Print the scan + proposed config without writing (non-TTY, no --yes). */
function reportNonTty(
  report: IScanReport,
  recommended: IConventions,
  write: (s: string) => void
): number {
  write(
    `\ntsforge setup (non-interactive)\n` +
      `  stack: ${report.stack.name} (${report.stack.confidence})\n` +
      `  files scanned: ${report.filesScanned}\n\n` +
      `Proposed conventions:\n${configPreview(recommended)}\n\n` +
      `${SAFETY_NOTE}\n` +
      `Re-run in a terminal to choose interactively, or pass --yes to write these.\n`
  );

  return 0;
}

/**
 * Run `tsforge setup`. Interactive TTY ⇒ the wizard (nothing written until Apply);
 * `--yes` ⇒ writes the scan's recommendations non-interactively; non-TTY without
 * `--yes` ⇒ prints the scan + proposal and writes nothing. Returns an exit code.
 */
export async function runSetup(opts: IRunSetupOptions): Promise<number> {
  const write = opts.out ?? ((s: string): void => void process.stdout.write(s));
  const report = await scanRepo(opts.cwd);
  const recommended = recommendConventions(report);

  if (opts.yes) {
    return applyAndReport(opts, recommended, report, write);
  }

  const interactive =
    opts.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);

  if (!interactive) {
    return reportNonTty(report, recommended, write);
  }

  const steps = buildSteps(report);
  const final = await runWizard(steps, opts.color, {
    title: "tsforge setup",
    extra: (state) =>
      `${configPreview(selectionsToConventions(state))}\n\n${SAFETY_NOTE}`,
  });

  if (final.status !== "apply") {
    write("\nSetup cancelled — nothing written.\n");

    return 0;
  }

  return applyAndReport(opts, selectionsToConventions(final), report, write);
}
