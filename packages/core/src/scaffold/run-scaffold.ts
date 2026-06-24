import { applyScaffold, type IConfigureDeps } from "./configure";
import { cloneRepo, scaffoldRecord } from "./clone";
import { bootStack, type IBootDeps } from "./boot";
import { answersToPlan } from "./plan";
import type { IScaffoldFs } from "./io";
import type {
  IArchetypeProfile,
  IScaffoldAnswers,
  IScaffoldManifest,
} from "./scaffold.types";

/** Compose an archetype's gate list into a single shell command. A gate whose
 *  `cwd` is `.` runs in place; others are wrapped in a subshell `cd`. The whole
 *  command is run with cwd = the handoff dir, so `cwd` values are relative to it. */
export function gateCommand(profile: IArchetypeProfile): string {
  return profile.gates
    .map((g) => (g.cwd === "." ? g.command : `(cd ${g.cwd} && ${g.command})`))
    .join(" && ");
}

export interface IScaffoldDeps extends IConfigureDeps {
  readonly boot: Pick<IBootDeps, "poll" | "timeoutMs">;
  /** Skip the Docker boot (CI / `--no-boot` / STACK=smoke). */
  readonly skipBoot?: boolean;
}

export interface IScaffoldOutcome {
  readonly dir: string;
  /** Where the harness then runs the gate (the subPath for Astro, else the root). */
  readonly gateCwd: string;
  readonly gateCommand: string;
  readonly resolvedSha: string;
  readonly booted: boolean;
  readonly bootError?: string;
  readonly summary: readonly string[];
}

/**
 * Stand up a project from boringstack end-to-end: resolve the plan, clone at the
 * manifest ref, record replay metadata, drive boringstack's own configure scripts,
 * optionally boot the stack, and return the handoff (where + how to run the gate).
 * Throws on a cross-rule violation — an invalid config must never be applied.
 */
export async function runScaffold(
  manifest: IScaffoldManifest,
  answers: IScaffoldAnswers,
  dest: string,
  deps: IScaffoldDeps
): Promise<IScaffoldOutcome> {
  const plan = answersToPlan(manifest, answers);

  if (plan.violations.length > 0) {
    throw new Error(
      `scaffold: configuration is invalid — ${plan.violations.join("; ")}`
    );
  }

  const { resolvedSha } = await cloneRepo(
    manifest.repo,
    manifest.defaultRef,
    dest,
    deps.run
  );

  await writeRecord(deps.fs, dest, {
    source: manifest.repo,
    ref: manifest.defaultRef,
    resolvedSha,
    archetype: answers.archetype,
    manifestVersion: manifest.manifestVersion,
  });

  const configured = await applyScaffold(dest, manifest, plan, deps);

  const profile = manifest.archetypes[answers.archetype];
  const gateCwd =
    profile.subPath === undefined ? dest : `${dest}/${profile.subPath}`;

  const boot = await maybeBoot(dest, manifest, answers, deps);

  return {
    dir: dest,
    gateCwd,
    gateCommand: gateCommand(profile),
    resolvedSha,
    booted: boot.booted,
    ...(boot.error === undefined ? {} : { bootError: boot.error }),
    summary: configured.summary,
  };
}

async function maybeBoot(
  dest: string,
  manifest: IScaffoldManifest,
  answers: IScaffoldAnswers,
  deps: IScaffoldDeps
): Promise<{ booted: boolean; error?: string }> {
  // Boot is full-stack only and opt-out-able; Astro is a static build, no stack.
  if (answers.archetype !== "boringstack" || deps.skipBoot === true) {
    return { booted: false };
  }

  return bootStack(dest, manifest, {
    run: deps.run,
    poll: deps.boot.poll,
    ...(deps.boot.timeoutMs === undefined
      ? {}
      : { timeoutMs: deps.boot.timeoutMs }),
  });
}

async function writeRecord(
  fs: IScaffoldFs,
  dest: string,
  record: Parameters<typeof scaffoldRecord>[0]
): Promise<void> {
  await fs.writeText(
    `${dest}/.tsforge/scaffold.json`,
    `${JSON.stringify(scaffoldRecord(record), null, 2)}\n`
  );
}
