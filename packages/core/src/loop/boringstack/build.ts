import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  IGreenfieldDeps,
  IFeature,
  IGreenfieldState,
  IGreenfieldResult,
  IGreenfieldOptions,
} from "../greenfield/greenfield.types";
import type { IProvider } from "../../inference";
import type { IGate } from "../../gate/gate-runner";
import type { Exec } from "./exec";
import { generateResource, generateFeature } from "./generate";
import { runBoringstackGate } from "./gate";
import { extractFailures } from "./extract-failures";
import { resolveStuckFile } from "../expert-handoff";
import { refinePrompt } from "./refine-prompt";
import { runGreenfield } from "../greenfield/run";
import { composeBoringstackGate } from "./gate-stages";
import type { Reporter, IHandoff, EscalationRung } from "../loop.types";
import { slicesToFeatures } from "./plan-resources";
import { toCamelCase } from "./case";
import { loadApprovedPlan } from "../planning/plan-store";
import type { ISlice } from "../planning/plan-types";

/** Apply BoringStack's DETERMINISTIC auto-fixes over both apps before the gate:
 *  `format` (prettier, canonical formatting) then `lint:fix` (eslint --fix for the
 *  auto-fixable lint rules prettier can't touch — padding-line, import order, etc.).
 *  Neither changes logic, so neither should ever cost the model a gate attempt — a
 *  dev gets both on save. Best-effort: a missing script or non-zero exit is ignored;
 *  the gate stays the source of truth. */
export async function autofixApps(cwd: string, exec: Exec): Promise<void> {
  for (const app of ["apps/api", "apps/ui"]) {
    const appCwd = join(cwd, app);

    await exec(["bun", "run", "format"], { cwd: appCwd });
    await exec(["bun", "run", "lint:fix"], { cwd: appCwd });
  }
}

/**
 * The single file to hand the expert when a feature is stuck. A GATE failure names
 * a file in its errors (`resolveStuckFile` parses it). A JUDGE failure is a prose
 * critique with no file path — so fall back to the resource's SERVICE file, where
 * the domain logic the judge flags (missing fields, absent state transitions) lives.
 * Null only when neither resolves. Exported for unit testing.
 */
export async function rescueFileFor(
  cwd: string,
  feature: IFeature
): Promise<string | null> {
  const fromError = await resolveStuckFile(cwd, [
    { message: feature.lastError ?? "" },
  ]);

  if (fromError !== null) {
    return fromError;
  }

  const camel = toCamelCase(feature.id);
  const service = `apps/api/src/api/${camel}/${camel}.service.ts`;

  return (await Bun.file(join(cwd, service)).exists()) ? service : null;
}

/**
 * Generate the scope globs for a resource: the files the model is allowed to edit
 * for this feature.
 */
/** The shared Drizzle schema file that holds every app-domain table (including the
 *  one `new:resource` generates for a feature). The model MUST be able to add its
 *  entity's domain columns here — otherwise it can only fake persistence in memory,
 *  which passes the mocked tests but stores nothing. It's instructed (refinePrompt)
 *  to touch ONLY its own table. */
export const APP_SCHEMA_FILE =
  "apps/api/src/clients/postgres/schema/app.schema.ts";

/** The i18n locale files. The gate forbids literal UI strings, so a real feature UI
 *  MUST reference i18n keys — and `i18n-keys/static-translation-key-exists` fails any
 *  key that isn't defined here. The keys live in shared per-locale files (not the
 *  feature dir), so the model has to be able to ADD its keys here or it's trapped
 *  (observed live: 8 static-translation-key-exists failures it couldn't fix). It's
 *  instructed (refinePrompt) to only ADD its feature's keys, never touch others'. */
export const LOCALE_GLOB = "apps/ui/src/lib/i18n/locales/**";

export function scopeFor(name: string): string[] {
  const camel = toCamelCase(name);

  return [
    `apps/api/src/api/${camel}/**`,
    `apps/api/tests/api/${camel}/**`,
    `apps/ui/src/features/${camel}/**`,
    // The entity's table + columns live in the shared app schema (not the resource
    // dir), so a greenfield build must let the model add its domain columns there.
    APP_SCHEMA_FILE,
    // Same story for i18n: any UI string is a locale key, and the keys live in
    // shared locale files — the model must be able to add the keys it references.
    LOCALE_GLOB,
  ];
}

/**
 * Read the generated resource code from the filesystem.
 * Concatenates TypeScript files from both the API resource and UI feature directories,
 * capped at ~16000 characters. Returns empty string if directories don't exist.
 */
export async function readResourceCode(
  cwd: string,
  name: string
): Promise<string> {
  const camel = toCamelCase(name);
  const blocks: string[] = [];
  const maxChars = 16000;
  let totalLen = 0;

  // Read API resource files (apps/api/src/api/<camel>/)
  const apiDir = join(cwd, "apps/api/src/api", camel);

  try {
    const apiFiles = await readdir(apiDir, { recursive: false });
    const tsFiles = apiFiles.filter(
      (f): f is string => typeof f === "string" && f.endsWith(".ts")
    );

    for (const file of tsFiles) {
      const relPath = `apps/api/src/api/${camel}/${file}`;
      const content = await readFile(join(apiDir, file), "utf-8");
      const block = `// ${relPath}\n${content}\n`;

      if (totalLen + block.length > maxChars) {
        blocks.push(`\n…[truncated]`);
        break;
      }

      blocks.push(block);
      totalLen += block.length;
    }
  } catch {
    // Directory doesn't exist, skip
  }

  // Read UI feature files (apps/ui/src/features/<camel>/, recursively)
  if (totalLen < maxChars) {
    const uiDir = join(cwd, "apps/ui/src/features", camel);

    try {
      const uiFiles = await readdir(uiDir, { recursive: true });
      const tsFiles = uiFiles.filter(
        (f): f is string => typeof f === "string" && f.endsWith(".ts")
      );

      for (const file of tsFiles) {
        const relPath = `apps/ui/src/features/${camel}/${file}`;
        const fullPath = join(uiDir, file);
        const content = await readFile(fullPath, "utf-8");
        const block = `// ${relPath}\n${content}\n`;

        if (totalLen + block.length > maxChars) {
          blocks.push(`\n…[truncated]`);
          break;
        }

        blocks.push(block);
        totalLen += block.length;
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  return blocks.join("");
}

/**
 * The host interface that the build driver uses to communicate with the session.
 * The Session satisfies this structurally.
 */
interface IBoringstackHost {
  setScope(globs: string[]): void;
  setGate(gate: IGate): void;
  setExpertRescueTarget(file: string): void;
  captureMetaBaseline(): void;
  send(
    message: string
  ): Promise<{ status: string; turns: number; handoff?: IHandoff }>;
}

function revisitGuidance(seed?: { triedLevers: EscalationRung[] }): string {
  if (seed === undefined || seed.triedLevers.length === 0) {
    return "";
  }

  return (
    "\n\nREVISIT: the previous drive exhausted these approaches: " +
    `${seed.triedLevers.join(", ")}. The convergence state is fresh now; inspect ` +
    "the current gate failure and take a materially different route instead of " +
    "repeating those approaches."
  );
}

/**
 * Create the greenfield dependencies for the BoringStack build, composing Tasks 1-6.
 * - `implement` generates the resource, freezes the scope, injects the live composed
 *   gate, and sends the refine prompt. The escalation ladder runs INSIDE settleGate
 *   in the session; implement returns {done} or {done:false,handoff} accordingly.
 */
export function boringstackDeps(opts: {
  host: IBoringstackHost;
  cwd: string;
  exec: Exec;
  evaluator: IProvider;
  /** Failure signatures present on the PRISTINE scaffold (before any model work).
   *  The gate is differential against this: a feature passes when it introduces no
   *  NEW failures, so pre-existing base-suite/scaffold defects the model is frozen
   *  out of can't wedge every feature. Empty = a clean baseline (the ideal). */
  baseline?: ReadonlySet<string>;
  generate?: (cwd: string, name: string, exec: Exec) => Promise<void>;
  generateUi?: (cwd: string, name: string, exec: Exec) => Promise<void>;
  /** Look up the plan slice for a feature by its id. Supplied by runBoringstackBuild
   *  when building from an approved plan; undefined when planning ad-hoc. */
  sliceFor?: (id: string) => ISlice | undefined;
}): IGreenfieldDeps {
  const {
    host,
    cwd,
    exec,
    evaluator,
    generate: generateFn,
    generateUi,
    sliceFor,
  } = opts;
  const generate = generateFn ?? generateResource;
  const genUi = generateUi ?? generateFeature;
  const baseline = opts.baseline ?? new Set<string>();

  return {
    async implement(
      feature: IFeature,
      _state: IGreenfieldState,
      seed?: { triedLevers: EscalationRung[] }
    ): Promise<{ done: boolean; handoff?: IHandoff }> {
      // Pre-step: generate the full vertical slice + sync the STUB schema. The
      // model then fills the domain INSIDE the loop, checked by the live gate.
      await generate(cwd, feature.id, exec);
      await genUi(cwd, feature.id, exec);
      host.setScope(scopeFor(feature.id));
      // The editable file the expert repairs if a stall's errors are all out of
      // scope (locked consumers of this feature's types) — its service file.
      host.setExpertRescueTarget((await rescueFileFor(cwd, feature)) ?? "");
      await exec(["bun", "run", "db:push", "--", "--force"], {
        cwd: join(cwd, "apps/api"),
      });

      // Inject THIS feature's composed gate (differential command + reachability +
      // judge). Now settleGate runs it every cycle and the shared ladder escalates
      // on lint/judge/reachability failures — the whole point of the unification.
      host.setGate(
        composeBoringstackGate({ cwd, exec, evaluator, baseline, feature })
      );

      const slice = sliceFor?.(feature.id);
      const sent = await host.send(
        refinePrompt(feature, slice) + revisitGuidance(seed)
      );

      return {
        done: sent.status === "done",
        ...(sent.handoff !== undefined ? { handoff: sent.handoff } : {}),
      };
    },
  };
}

/**
 * Report the pristine-scaffold baseline. Keys off `passed`, NOT `size`: a RED
 * baseline whose output did not parse into any known failure signatures (size 0)
 * must NOT be announced GREEN — that both lies and hides that the differential gate
 * can suppress NOTHING (every failure counts as novel), so the model would inherit
 * pre-existing scaffold failures with no protection. Exported for unit testing.
 */
export function describeBaseline(
  passed: boolean,
  size: number
): { kind: "tool" | "stuck"; message: string } {
  if (passed) {
    return {
      kind: "tool",
      message:
        "baseline scaffold is GREEN — features graded against a clean gate.",
    };
  }

  if (size > 0) {
    return {
      kind: "stuck",
      message:
        `⚠ baseline scaffold is RED: ${String(size)} pre-existing gate failure(s) ` +
        `EXCLUDED from feature grading (differential gate). The app won't be fully ` +
        `green until the scaffold baseline is fixed.`,
    };
  }

  return {
    kind: "stuck",
    message:
      "⚠ baseline scaffold is RED but its output did NOT parse into known failure " +
      "signatures — the differential gate CANNOT suppress these, so every feature " +
      "will inherit them. Fix the scaffold's own gate first.",
  };
}

/**
 * Run the BoringStack build driver: require an approved plan, derive features
 * from its slices, and drive them through the greenfield loop
 * (implement → evaluate → persist).
 */
export async function runBoringstackBuild(opts: {
  cwd: string;
  goal: string;
  evaluator: IProvider;
  exec: Exec;
  host: IBoringstackHost;
  onEvent?: Reporter;
  generate?: (cwd: string, name: string, exec: Exec) => Promise<void>;
  generateUi?: (cwd: string, name: string, exec: Exec) => Promise<void>;
}): Promise<IGreenfieldResult> {
  const { cwd, goal, evaluator, exec, host, onEvent, generate, generateUi } =
    opts;

  // Require an approved plan before building
  const approved = await loadApprovedPlan(cwd);

  if (approved === null) {
    return { status: "needs-plan", features: [] };
  }

  // Derive features from the plan's slices
  const features = slicesToFeatures(approved.slices);

  if (features.length === 0) {
    return { status: "done", features: [] };
  }

  const state: IGreenfieldState = {
    goal,
    features,
  };

  // Capture the BASELINE gate on the pristine scaffold (before any resource is
  // generated) so feature grading is differential — the model is judged only on
  // failures IT introduces, never on pre-existing base-suite/scaffold defects it's
  // frozen out of. A red baseline is surfaced LOUDLY (not silently tolerated): it
  // means the scaffold itself doesn't pass its own gate and should be fixed.
  onEvent?.({
    kind: "tool",
    task: "boringstack",
    message: "capturing baseline gate on the pristine scaffold…",
  });

  const baseRun = await runBoringstackGate(cwd, exec);
  const baseline = baseRun.passed
    ? new Set<string>()
    : extractFailures(baseRun.output, cwd);

  const report = describeBaseline(baseRun.passed, baseline.size);

  onEvent?.({
    kind: report.kind,
    task: "boringstack",
    message: report.message,
  });

  // Capture the PRISTINE meta-rule baseline too (workflow perms, lockfile, etc. that
  // the model is frozen out of). The command baseline above only covers the command
  // gate; meta violations are subtracted separately, via the session, every cycle.
  host.captureMetaBaseline();

  // Create a lookup function that maps feature ids to their plan slices
  const sliceFor = (id: string): ISlice | undefined =>
    approved.slices.find((slice) => slice.entity.id === id);

  // Run the greenfield loop with BoringStack-specific dependencies
  const optsGreenfield: IGreenfieldOptions = {};

  if (onEvent) {
    optsGreenfield.onEvent = onEvent;
  }

  const result = await runGreenfield(
    cwd,
    state,
    boringstackDeps({
      host,
      cwd,
      exec,
      evaluator,
      baseline,
      sliceFor,
      generate,
      generateUi,
    }),
    optsGreenfield
  );

  // Final acceptance: the per-cycle loop uses the FAST gate (check + tests, no build/
  // size/coverage) for speed. When every feature has passed, run the FULL gate ONCE
  // so the expensive acceptance-only checks (production build, size:check, full UI
  // coverage, repo-root drift) still run — just once at the end, not every turn.
  // Best-effort + LOUD: it reports issues for a human rather than silently flipping
  // the verdict (a pre-existing scaffold size/build budget must not fail the feature).
  if (result.status === "done") {
    onEvent?.({
      kind: "tool",
      task: "boringstack",
      message: "final acceptance: full validate + build + size checks…",
    });

    // GATE PARITY: the per-cycle fast gate applies deterministic auto-fixes
    // (prettier + eslint --fix) BEFORE it runs, but the full acceptance gate did
    // not — so a feature could freeze fast-green yet fail final `validate` on
    // auto-fixable formatting the model was never shown (e.g. a missing `;`).
    // Apply the SAME auto-fixes here so acceptance and the per-cycle gate agree;
    // this normalizes formatting a dev gets on save, it does not suppress errors.
    await autofixApps(cwd, exec);

    const full = await runBoringstackGate(cwd, exec, "full");

    onEvent?.({
      kind: full.passed ? "done" : "stuck",
      task: "boringstack",
      message: full.passed
        ? "✓ final acceptance GREEN — full validate + build + size checks all pass."
        : "⚠ features passed the fast gate, but the FULL acceptance gate (build / " +
          "size / coverage / root drift) found issues — review before shipping:\n" +
          full.output.slice(-1200),
    });
  }

  return result;
}
