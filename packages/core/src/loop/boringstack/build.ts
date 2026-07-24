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
import type { ISlice, IProductPlan } from "../planning/plan-types";
import { planToAcceptanceSpec } from "../acceptance/acceptance-spec";
import { buildTestIdGuide } from "./acceptance/testid-contract";
import type {
  IEntityAcceptance,
  IAcceptanceRunner,
  IAcceptanceRunCtx,
  IAcceptanceSpec,
} from "../acceptance/acceptance.types";
import { acceptanceSteer } from "../acceptance/acceptance-steer";
import { readHostPorts, hostPortOr } from "../../scaffold";
import { FLAG_ON, ENV_FLAG } from "../../config/config.constants";

/** Apply BoringStack's DETERMINISTIC auto-fixes over both apps before the gate:
 *  `lint:fix` (eslint --fix for the auto-fixable lint rules — padding-line, import order, etc.)
 *  then `format` (prettier, canonical formatting) — in THAT order, prettier LAST. Neither changes
 *  logic, so neither should ever cost the model a gate attempt — a dev gets both on save. The
 *  order is load-bearing: prettier must run after eslint --fix so the gate's `format:check`
 *  always converges (if prettier ran first, eslint --fix could re-format after it and format:check
 *  would then fail with nothing left to fix it — see the ORDER MATTERS note in the body).
 *  Best-effort: a missing script or non-zero exit is ignored; the gate stays the source of truth. */
export async function autofixApps(cwd: string, exec: Exec): Promise<void> {
  for (const app of ["apps/api", "apps/ui"]) {
    const appCwd = join(cwd, app);

    // Clear eslint's cache FIRST. `eslint --cache` (which the app's lint/lint:fix scripts
    // use) is UNSOUND for TYPE-AWARE rules: it keys on a file's own content, so a file
    // whose content is unchanged stays cached-CLEAN even when a CROSS-FILE type change
    // introduced a `no-unsafe-*` / type-checked violation in it. Live-observed break: the
    // fast gate read a stale-clean cache and marked a feature GREEN while
    // `no-unsafe-assignment` errors existed in a route test, which only surfaced at full
    // acceptance — a gate-parity hole (4/4 panel). `lint:fix` re-populates a fresh cache
    // for this cycle right after, so the later `check` → `lint` read stays fast AND sound.
    await exec(["rm", "-f", ".eslintcache"], { cwd: appCwd });
    // ORDER MATTERS: `lint:fix` (eslint --fix) BEFORE `format` (prettier --write) — prettier must
    // be the LAST formatter. If prettier runs first and eslint --fix then re-formats (import order,
    // etc.), the gate's later `format:check` (prettier --check) fails on what eslint --fix changed,
    // and since prettier --write already ran there's nothing left to converge it — the build burns
    // cycles on a format error autofix can't clear (live: build44 Contact hit `format:check` on
    // ContactPage.types.ts every cycle → opaqueGateError). Running prettier LAST gives it the final
    // say, so `format:check` is always clean. (Prettier changing a file after lint:fix invalidates
    // only that file's eslint-cache entry, which the gate then re-lints — still sound.)
    await exec(["bun", "run", "lint:fix"], { cwd: appCwd });
    await exec(["bun", "run", "format"], { cwd: appCwd });
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

/** The shared app sidebar navigation component. Features are unreachable (fail browser
 *  acceptance tests) if the model doesn't register a NavLink for the feature in the
 *  sidebar. ADD-ONLY shared file: the worker adds only its own NavLink, accepted like
 *  APP_SCHEMA_FILE/LOCALE_GLOB (filesystem scope grants write, differential gate + judge
 *  catch any regression to another feature's nav). It's instructed (refinePrompt) to ADD
 *  ONLY its feature's link, never modify another feature's entry or remove entries. */
export const APP_SIDEBAR_FILE =
  "apps/ui/src/components/core/AppSidebar/AppSidebar.tsx";

/** The shared router configuration file. A feature without a route entry is unreachable
 *  (knip flags the page as unused). ADD-ONLY shared file: the worker adds only its own
 *  route, same trade-off as APP_SIDEBAR_FILE. It's instructed (refinePrompt) to ADD ONLY
 *  its feature's route entry, never modify another feature's route. */
export const APP_ROUTES_FILE = "apps/ui/src/app/router/routes.tsx";

/** The sidebar's co-located test. It asserts the EXACT number of nav links, so the moment a
 *  feature adds its NavLink (required for reachability) the count changes and this test fails at
 *  the FINAL full-project validate (the fast per-feature gate doesn't run the vitest suite, so it
 *  only surfaces there → a fully-verified feature still leaves the build "stuck"). The scaffold is
 *  an external clone we can't edit, so the model must keep this test in sync: scope it in and
 *  instruct (refinePrompt) to bump the expected link count by its one added link — nothing else. */
export const APP_SIDEBAR_TEST_FILE =
  "apps/ui/src/components/core/AppSidebar/AppSidebar.test.tsx";

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
    // The sidebar and router are shared UI files. A feature is unreachable (fails
    // browser acceptance) unless the model adds a NavLink to the sidebar and a route
    // to the router. Add-only: the model may ADD its feature's entry, never modify others'.
    APP_SIDEBAR_FILE,
    APP_ROUTES_FILE,
    // Co-located sidebar test asserts the exact nav-link count; adding a NavLink changes it, so
    // the model must be able to bump the count (see APP_SIDEBAR_TEST_FILE).
    APP_SIDEBAR_TEST_FILE,
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
 * Run acceptance verification for a feature after the fast gate passes.
 * Returns the done status and optional handoff; handles runner missing, infra errors, and assertion failures.
 */
async function verifyAcceptance(
  sent: { status: string; handoff?: IHandoff },
  host: IBoringstackHost,
  cwd: string,
  entity: IEntityAcceptance | undefined,
  acceptanceRunner: IAcceptanceRunner | undefined,
  e2eAcceptanceDisabled: boolean,
  fullSpec?: IAcceptanceSpec
): Promise<{ done: boolean; handoff?: IHandoff; infra?: string }> {
  // If acceptance is not enabled, return based on fast gate
  if (!(!e2eAcceptanceDisabled && sent.status === "done")) {
    return {
      done: sent.status === "done",
      ...(sent.handoff !== undefined ? { handoff: sent.handoff } : {}),
    };
  }

  // FAIL-CLOSED: if acceptance is enabled and entity exists but runner is missing,
  // this is a misconfiguration — reject the feature until the runner is injected
  if (entity && !acceptanceRunner) {
    return { done: false };
  }

  // Run acceptance only if we have an entity and runner
  if (entity && acceptanceRunner) {
    const hostPorts = readHostPorts(cwd);
    const apiPort = hostPortOr(hostPorts, "API_HOST_PORT");
    const uiPort = hostPortOr(hostPorts, "UI_HOST_PORT");
    const ctx: IAcceptanceRunCtx = {
      cwd,
      apiBase: `http://localhost:${apiPort}`,
      uiBase: `http://localhost:${uiPort}`,
    };

    const outcome = await acceptanceRunner.run(entity, ctx, fullSpec);

    // Infrastructure error: route to needs-infra path; per-slice acceptance is best-effort.
    // The feature's fast-gate pass is valid, but acceptance verification cannot complete
    // due to infrastructure. Return infra error to thread it through the outer loop.
    if (outcome.infraError !== undefined) {
      return { done: false, infra: outcome.infraError };
    }

    // Test assertion failed: emit steer, re-verify, and close over post-steer state
    if (!outcome.ok) {
      const steer = acceptanceSteer(entity, outcome);

      const steerSend = await host.send(steer);

      // FIX 2: after sending the steer (which runs the full model loop),
      // re-run acceptance once to see if the fix worked
      const reRun = await acceptanceRunner.run(entity, ctx, fullSpec);

      // If the re-run is an infra error, route it through the needs-infra channel
      if (reRun.infraError !== undefined) {
        return { done: false, infra: reRun.infraError };
      }

      // Return done:true ONLY when both the steer completed AND the re-run passed.
      // If the steer did not complete (stuck), return done:false even if re-run passed.
      return {
        done: steerSend.status === "done" && reRun.ok,
        ...(steerSend.handoff !== undefined
          ? { handoff: steerSend.handoff }
          : {}),
      };
    }

    // All checks passed
    return { done: true };
  }

  return {
    done: true,
    ...(sent.handoff !== undefined ? { handoff: sent.handoff } : {}),
  };
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
  /** The acceptance runner for per-slice E2E verification. When provided and the
   *  flag is enabled, features are gated on per-slice acceptance after the fast gate
   *  passes. */
  acceptanceRunner?: IAcceptanceRunner;
  /** The full plan spec (all entities), used for recursive parent seeding in
   *  per-slice acceptance. When provided, seeding code can reference parent field
   *  metadata from the full plan rather than fallback placeholders. */
  fullSpec?: IAcceptanceSpec;
}): IGreenfieldDeps {
  const {
    host,
    cwd,
    exec,
    evaluator,
    generate: generateFn,
    generateUi,
    sliceFor,
    acceptanceRunner,
    fullSpec,
  } = opts;
  const generate = generateFn ?? generateResource;
  const genUi = generateUi ?? generateFeature;
  const baseline = opts.baseline ?? new Set<string>();
  const e2eAcceptanceDisabled =
    process.env[ENV_FLAG.noE2eAcceptance] === FLAG_ON;

  return {
    async implement(
      feature: IFeature,
      state: IGreenfieldState,
      seed?: { triedLevers: EscalationRung[] }
    ): Promise<{ done: boolean; handoff?: IHandoff; infra?: string }> {
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
      // The OTHER features' ids are handed to the judge so it scopes to this
      // feature's own responsibilities and never rejects it for lacking a link to a
      // sibling entity a different slice owns (the relational-collision park).
      const siblingEntities = state.features
        .filter((f) => f.id !== feature.id)
        .map((f) => f.id);

      const slice = sliceFor?.(feature.id);
      let entity: IEntityAcceptance | undefined;

      if (slice !== undefined) {
        const spec = planToAcceptanceSpec({
          product: "BoringStack",
          slices: [slice],
        });

        entity = spec.entities[0];
      }

      host.setGate(
        composeBoringstackGate({
          cwd,
          exec,
          evaluator,
          baseline,
          feature,
          entity,
          siblingEntities,
        })
      );

      // FIX 7: only include testid guide when acceptance is enabled
      const testIdGuide =
        entity !== undefined && !e2eAcceptanceDisabled
          ? "\n\n" + buildTestIdGuide(entity)
          : "";
      const sent = await host.send(
        refinePrompt(feature, slice) + testIdGuide + revisitGuidance(seed)
      );

      return verifyAcceptance(
        sent,
        host,
        cwd,
        entity,
        acceptanceRunner,
        e2eAcceptanceDisabled,
        fullSpec
      );
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

export interface IBaselinePartition {
  /** `openapi-unreachable` signatures from the pristine gate: an INFRA precondition
   *  failure (the API isn't serving its OpenAPI spec), never a real baseline. */
  infra: string[];
  /** Everything else — the genuine pre-existing scaffold defects that form the
   *  differential baseline features are graded against. */
  baseline: Set<string>;
}

/**
 * Split the pristine gate's failure signatures into infra-precondition failures
 * (`openapi-unreachable`) and everything else. `openapi-unreachable` must NEVER enter
 * the differential baseline: if it did, `differentialStage` would suppress it forever
 * and a feature whose only failure is the API being down would "pass" green with a
 * stale/wrong client. It also must not be silently dropped (that would let
 * `describeBaseline` misreport a RED-only-because-of-infra gate as "did NOT parse").
 * The caller fails LOUD + closed on a non-empty `infra` list instead.
 */
export function partitionBaseline(
  signatures: Iterable<string>
): IBaselinePartition {
  const infra: string[] = [];
  const baseline = new Set<string>();

  for (const sig of signatures) {
    if (sig.startsWith("openapi-unreachable:")) {
      infra.push(sig);
    } else {
      baseline.add(sig);
    }
  }

  return { infra, baseline };
}

/**
 * Run the final acceptance gate and chain verification after all features pass the fast gate.
 * Note: approved is guaranteed to be non-null (checked by caller).
 */
export async function runFinalAcceptance(
  result: IGreenfieldResult,
  cwd: string,
  exec: Exec,
  acceptanceRunner: IAcceptanceRunner | undefined,
  approved: IProductPlan,
  e2eAcceptanceDisabled: boolean,
  onEvent?: Reporter
): Promise<IGreenfieldResult> {
  if (result.status !== "done") {
    return result;
  }

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

  let finalPassed = full.passed;
  let finalMessage = full.passed
    ? "✓ final acceptance GREEN — full validate + build + size checks all pass."
    : "⚠ features passed the fast gate, but the FULL acceptance gate (build / " +
      "size / coverage / root drift) found issues — review before shipping:\n" +
      full.output.slice(-1200);

  // FAIL-CLOSED: if acceptance is enabled but runner is missing, reject the feature
  if (full.passed && !e2eAcceptanceDisabled && !acceptanceRunner) {
    const missingRunnerMsg =
      "acceptance enabled but no runner injected — cannot verify relational chain. " +
      "This is a misconfiguration; the acceptance runner must be provided.";

    onEvent?.({
      kind: "stuck",
      task: "boringstack",
      message: missingRunnerMsg,
    });

    return { ...result, status: "stuck" };
  }

  // After base gate passes, run relational chain acceptance (if available)
  if (full.passed && !e2eAcceptanceDisabled && acceptanceRunner) {
    const hostPorts = readHostPorts(cwd);
    const apiPort = hostPortOr(hostPorts, "API_HOST_PORT");
    const uiPort = hostPortOr(hostPorts, "UI_HOST_PORT");
    const ctx: IAcceptanceRunCtx = {
      cwd,
      apiBase: `http://localhost:${apiPort}`,
      uiBase: `http://localhost:${uiPort}`,
    };

    const spec = planToAcceptanceSpec(approved);
    const chainOutcome = await acceptanceRunner.runChain(spec, ctx);

    // Infrastructure error: route to infra-abort path, not feature red
    // Final acceptance with infra error means build didn't actually complete verification
    if (chainOutcome.infraError !== undefined) {
      const infraMsg = `Acceptance chain: ${chainOutcome.infraError}`;

      return {
        status: "needs-infra",
        features: result.features,
        infra: infraMsg,
      };
    }

    // Chain assertion failed: flip final to not-green with detail
    if (!chainOutcome.ok) {
      finalPassed = false;
      finalMessage = `chain acceptance failed: ${chainOutcome.detail ?? "assertion failure in relational flow"}`;
    }
  }

  onEvent?.({
    kind: finalPassed ? "done" : "stuck",
    task: "boringstack",
    message: finalMessage,
  });

  // If the final acceptance chain failed AND acceptance is enabled, flip to stuck.
  // When acceptance is disabled, preserve the original status (do not flip).
  if (!finalPassed && !e2eAcceptanceDisabled) {
    return { ...result, status: "stuck" };
  }

  return result;
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
  acceptanceRunner?: IAcceptanceRunner;
}): Promise<IGreenfieldResult> {
  const {
    cwd,
    goal,
    evaluator,
    exec,
    host,
    onEvent,
    generate,
    generateUi,
    acceptanceRunner,
  } = opts;

  const e2eAcceptanceDisabled =
    process.env[ENV_FLAG.noE2eAcceptance] === FLAG_ON;

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
  const { infra, baseline } = baseRun.passed
    ? { infra: [], baseline: new Set<string>() }
    : partitionBaseline(extractFailures(baseRun.output, cwd));

  // FAIL CLOSED on an unmet infra precondition. If the pristine gate can't reach the
  // API's OpenAPI spec, the UI's generate:api will fail EVERY cycle — driving the
  // model against infra it cannot fix. Stop here with a clear, actionable status
  // rather than start a build (this covers every entry path, and an API death between
  // the headless pre-flight and this baseline).
  if (infra.length > 0) {
    const classes = infra
      .map((sig) => sig.slice("openapi-unreachable:".length))
      .join(", ");
    const message =
      `the BoringStack API is not serving its OpenAPI spec (${classes}) — the UI ` +
      `regenerates its typed client from it every gate cycle. Bring the stack up ` +
      `(dev.sh up) before building. This is an infra precondition, not a code fix.`;

    onEvent?.({
      kind: "stuck",
      task: "boringstack",
      message: `✗ precondition not met: ${message}`,
    });

    return { status: "needs-infra", features: [], infra: message };
  }

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

  const fullSpec = planToAcceptanceSpec(approved);

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
      acceptanceRunner,
      fullSpec,
    }),
    optsGreenfield
  );

  // Final acceptance: the per-cycle loop uses the FAST gate (check + tests, no build/
  // size/coverage) for speed. When every feature has passed, run the FULL gate ONCE
  // so the expensive acceptance-only checks (production build, size:check, full UI
  // coverage, repo-root drift) still run — just once at the end, not every turn.
  // Best-effort + LOUD: it reports issues for a human rather than silently flipping
  // the verdict (a pre-existing scaffold size/build budget must not fail the feature).
  return runFinalAcceptance(
    result,
    cwd,
    exec,
    acceptanceRunner,
    approved,
    e2eAcceptanceDisabled,
    onEvent
  );
}
