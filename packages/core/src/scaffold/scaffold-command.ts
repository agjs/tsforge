import { runWizard } from "../render/wizard";
import { loadBundledManifest } from "./boringstack-manifest";
import { buildScaffoldSteps, stateToAnswers } from "./wizard";
import { scaffoldPreview } from "./preview";
import { parseScaffoldArgs } from "./scaffold-cli";
import { runScaffold, type IScaffoldOutcome } from "./run-scaffold";
import { realRunner, realFs, realPoller } from "./io";
import type { IScaffoldAnswers, IScaffoldManifest } from "./scaffold.types";

type IValues = Readonly<Record<string, string | readonly string[]>>;

/** Merge wizard-collected answers with explicit `--set`/`--multi` flag values;
 *  flags WIN (an explicit flag overrides what the wizard captured). Pure. */
export function mergeAnswerValues(
  wizard: IValues,
  flags: IValues
): Record<string, string | readonly string[]> {
  return { ...wizard, ...flags };
}

function withRef(manifest: IScaffoldManifest, ref: string): IScaffoldManifest {
  const repo = process.env.BORINGSTACK_REPO;

  return {
    ...manifest,
    ...(ref.length > 0 ? { defaultRef: ref } : {}),
    ...(repo !== undefined && repo.length > 0 ? { repo } : {}),
  };
}

/**
 * Interactive `--scaffold` command: pick the config in a wizard (with a live
 * topology/secrets/violations preview on the overview), then clone + configure +
 * boot boringstack. Archetype/stack/dest come from flags (`--archetype`/`--stack`/
 * `--dest`); the wizard collects the toggles, which `--set`/`--multi` flags can
 * override. Off a TTY (or when there are no steps, e.g. Astro) it skips the wizard
 * and uses the flag values directly. Returns null if the user cancels the wizard.
 */
export async function runScaffoldCommand(
  argv: readonly string[],
  color: boolean
): Promise<IScaffoldOutcome | null> {
  const opts = parseScaffoldArgs(argv);
  const manifest = withRef(loadBundledManifest(), opts.ref);
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

  return runScaffold(manifest, { archetype, stack, values }, opts.dest, {
    run: realRunner,
    fs: realFs,
    boot: { poll: realPoller },
    skipBoot: opts.skipBoot,
  });
}
