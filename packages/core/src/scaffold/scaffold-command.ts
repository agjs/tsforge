import { runWizard } from "../render/wizard";
import { buildScaffoldSteps, stateToAnswers } from "./wizard";
import { scaffoldPreview } from "./preview";
import { parseScaffoldArgs } from "./scaffold-cli";
import { loadScaffoldSource } from "./scaffold-source";
import {
  runScaffold,
  makeScaffoldRunDeps,
  type IScaffoldOutcome,
} from "./run-scaffold";
import type { IScaffoldAnswers } from "./scaffold.types";

type IValues = Readonly<Record<string, string | readonly string[]>>;

/** Merge wizard-collected answers with explicit `--set`/`--multi` flag values;
 *  flags WIN (an explicit flag overrides what the wizard captured). Pure. */
export function mergeAnswerValues(
  wizard: IValues,
  flags: IValues
): Record<string, string | readonly string[]> {
  return { ...wizard, ...flags };
}

/**
 * Interactive `--scaffold` command: pick the config in a wizard (with a live
 * topology/secrets/violations preview on the overview), then clone + configure +
 * optionally boot. Archetype/stack/dest come from flags (`--archetype`/`--stack`/
 * `--dest`); the wizard collects the toggles, which `--set`/`--multi` flags can
 * override. Off a TTY (or when there are no steps, e.g. Astro / Phaser) it skips
 * the wizard and uses the flag values directly. Returns null if the user cancels.
 */
export async function runScaffoldCommand(
  argv: readonly string[],
  color: boolean,
  // Injection seam for tests: the real scaffold runner by default. A test can pass a
  // fake to verify this command wires progress (onPhase) to stdout without a real
  // clone/boot.
  run: typeof runScaffold = runScaffold
): Promise<IScaffoldOutcome | null> {
  const opts = parseScaffoldArgs(argv);
  const manifest = loadScaffoldSource(opts.answers.archetype, opts.ref);
  const { archetype, stack } = opts.answers;
  const flagValues = opts.answers.values;

  const steps = buildScaffoldSteps(manifest, archetype, stack);
  let values: IValues = flagValues;

  if (process.stdin.isTTY && steps.length > 0) {
    const answersFor = (
      state: Parameters<typeof stateToAnswers>[3]
    ): IScaffoldAnswers => ({
      archetype,
      stack,
      values: mergeAnswerValues(
        stateToAnswers(manifest, archetype, stack, state).values,
        flagValues
      ),
    });

    const state = await runWizard(steps, color, {
      title: "tsforge scaffold",
      extra: (s) => scaffoldPreview(manifest, answersFor(s)),
    });

    if (state.status !== "apply") {
      return null;
    }

    values = answersFor(state).values;
  }

  return run(
    manifest,
    { archetype, stack, values },
    opts.dest,
    makeScaffoldRunDeps((line) => process.stdout.write(line), {
      skipBoot: opts.skipBoot,
    })
  );
}
