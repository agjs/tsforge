import { applyScaffold, type IConfigureDeps } from "./configure";
import { cloneRepo, scaffoldRecord } from "./clone";
import { bootStack, type IBootDeps } from "./boot";
import { answersToPlan } from "./plan";
import { parseManifest } from "./boringstack-manifest";
import { realRunner, realFs, realPoller, type IScaffoldFs } from "./io";
import { seedReactGreenfieldOpinionated } from "../config/seed-greenfield-profile";
import type {
  IArchetypeProfile,
  IScaffoldAnswers,
  IScaffoldManifest,
  IScaffoldPlan,
} from "./scaffold.types";

/** Repo-relative path to BoringStack's committed scaffold manifest. */
const CLONE_MANIFEST = ".tsforge/scaffold-manifest.json";

/** A cross-rule violation means the config is invalid and must never be applied. */
function assertValid(plan: IScaffoldPlan): void {
  if (plan.violations.length > 0) {
    throw new Error(
      `scaffold: configuration is invalid — ${plan.violations.join("; ")}`
    );
  }
}

/** Read + parse the manifest committed in the freshly-cloned repo (the source of
 *  truth). Null when absent or unparseable, so the caller falls back to the bundled
 *  bootstrap copy. */
async function readClonedManifest(
  fs: IScaffoldFs,
  dest: string
): Promise<IScaffoldManifest | null> {
  const path = `${dest}/${CLONE_MANIFEST}`;

  if (!(await fs.exists(path))) {
    return null;
  }

  // The file IS present → it is the source of truth. A parse failure is a hard
  // error (a broken BoringStack manifest), NOT a silent fall-back to the stale
  // bundle — that would scaffold with the wrong config behind the user's back.
  try {
    return parseManifest(JSON.parse(await fs.readText(path)));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    throw new Error(
      `scaffold: cloned ${CLONE_MANIFEST} is present but invalid — refusing to fall back to the bundled manifest: ${reason}`,
      { cause: err }
    );
  }
}

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
  /** Progress reporter for the long, otherwise-silent scaffold phases (clone,
   *  configure, boot). Called at each phase boundary so a caller can show the user
   *  what's happening instead of 20-30s of dead air. Absent → silent. Wrap a sink
   *  with {@link scaffoldPhaseReporter} for the standard "  → …" line format. */
  readonly onPhase?: (message: string) => void;
}

/** Wrap an output sink into an `onPhase` reporter with the standard progress-line
 *  format (`  → <message>\n`). Both scaffold entry points (the in-REPL wizard and
 *  the `tsforge scaffold` CLI) use this so the formatting stays in one tested place. */
export function scaffoldPhaseReporter(
  out: (line: string) => void
): (message: string) => void {
  return (message) => {
    out(`  → ${message}\n`);
  };
}

/** The real-IO {@link IScaffoldDeps} both entry points hand to {@link runScaffold},
 *  with progress wired to `out`. Extracted so the onPhase wiring each caller depends
 *  on is covered by one test instead of duplicated, untested, inline in each. */
export function makeScaffoldRunDeps(
  out: (line: string) => void,
  opts: { readonly skipBoot?: boolean } = {}
): IScaffoldDeps {
  return {
    run: realRunner,
    fs: realFs,
    boot: { poll: realPoller },
    onPhase: scaffoldPhaseReporter(out),
    ...(opts.skipBoot === undefined ? {} : { skipBoot: opts.skipBoot }),
  };
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
  /** Host ports assigned for per-project isolation (compose `.env` key → port).
   *  Empty for archetypes without a compose stack. */
  readonly ports: Readonly<Record<string, number>>;
}

/**
 * Stand up a project from boringstack end-to-end: resolve the plan, clone at the
 * manifest ref, record replay metadata, drive boringstack's own configure scripts,
 * optionally boot the stack, and return the handoff (where + how to run the gate).
 * Throws on a cross-rule violation — an invalid config must never be applied.
 */
export async function runScaffold(
  bootstrap: IScaffoldManifest,
  answers: IScaffoldAnswers,
  dest: string,
  deps: IScaffoldDeps
): Promise<IScaffoldOutcome> {
  const phase = deps.onPhase ?? ((): void => undefined);

  // The bundled manifest is ONLY the bootstrap (repo + ref); validation happens
  // post-clone against the repo's own manifest. We deliberately do NOT pre-validate
  // against the bundle — a config valid under a newer `--ref` must not be rejected
  // by stale bundled cross-rules.
  phase("Cloning the project template…");
  const { resolvedSha } = await cloneRepo(
    bootstrap.repo,
    bootstrap.defaultRef,
    dest,
    deps.run
  );

  const manifest = (await readClonedManifest(deps.fs, dest)) ?? bootstrap;
  const plan = answersToPlan(manifest, answers);

  assertValid(plan);

  const profile = manifest.archetypes[answers.archetype];

  // Strip template-only paths (e.g. BoringStack's own `apps/docs`) BEFORE configure,
  // so a scaffolded product neither ships nor gates against the template's docs —
  // and the removed files are never installed/built. Archetype-scoped, so the astro
  // archetype (whose product IS apps/docs) strips nothing.
  await stripTemplatePaths(deps.fs, dest, profile.strip ?? []);

  await writeRecord(deps.fs, dest, {
    source: bootstrap.repo,
    ref: bootstrap.defaultRef,
    resolvedSha,
    archetype: answers.archetype,
    manifestVersion: manifest.manifestVersion,
  });

  phase("Applying your configuration…");
  const configured = await applyScaffold(dest, manifest, plan, deps);
  const gateCwd =
    profile.subPath === undefined ? dest : `${dest}/${profile.subPath}`;

  // React UI scaffolds own the house layout — seed opinionated so STRUCTURE_RULES
  // gate. Generic gate setup must never do this; only React-owned handoffs.
  if (answers.archetype === "boringstack") {
    await seedReactGreenfieldOpinionated(gateCwd);
  }

  // maybeBoot reports its own "starting services" phase from the exact path that
  // boots, so the message can never diverge from whether a boot actually happens.
  const boot = await maybeBoot(dest, manifest, answers, deps, configured.ports);

  return {
    dir: dest,
    gateCwd,
    gateCommand: gateCommand(profile),
    resolvedSha,
    booted: boot.booted,
    ...(boot.error === undefined ? {} : { bootError: boot.error }),
    summary: configured.summary,
    ports: configured.ports,
  };
}

async function maybeBoot(
  dest: string,
  manifest: IScaffoldManifest,
  answers: IScaffoldAnswers,
  deps: IScaffoldDeps,
  hostPorts: Readonly<Record<string, number>>
): Promise<{ booted: boolean; error?: string }> {
  // Boot is full-stack only and opt-out-able; Astro is a static build, no stack.
  if (answers.archetype !== "boringstack" || deps.skipBoot === true) {
    return { booted: false };
  }

  // Reported here, on the path that actually boots — never from a duplicated
  // predicate elsewhere that could drift out of sync with this guard.
  deps.onPhase?.(
    "Starting services (Postgres, API, UI)… this can take ~20-30s"
  );

  return bootStack(dest, manifest, {
    run: deps.run,
    poll: deps.boot.poll,
    // The health URLs must target the ports THIS project published, not the
    // upstream defaults — otherwise an isolated boot false-fails its health check.
    hostPorts,
    ...(deps.boot.timeoutMs === undefined
      ? {}
      : { timeoutMs: deps.boot.timeoutMs }),
  });
}

/** Delete the archetype's template-only paths from the clone. Each is repo-relative
 *  and must stay INSIDE `dest` — an absolute or `..`-escaping entry is refused so a
 *  malformed manifest can never delete outside the scaffold. */
async function stripTemplatePaths(
  fs: IScaffoldFs,
  dest: string,
  paths: readonly string[]
): Promise<void> {
  for (const rel of paths) {
    if (
      rel.length === 0 ||
      rel.startsWith("/") ||
      rel.split("/").includes("..")
    ) {
      throw new Error(`scaffold: refusing to strip unsafe path "${rel}"`);
    }

    await fs.remove(`${dest}/${rel}`);
  }
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
