import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
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
import { applyHomeRedirect } from "./wire-resource";
import { runBoringstackGate } from "./gate";
import { extractFailures } from "./extract-failures";
import { resolveStuckFile } from "../expert-handoff";
import { refinePrompt } from "./refine-prompt";
import { runGreenfield } from "../greenfield/run";
import { greenfieldDir, hasState } from "../greenfield/state";
import { composeBoringstackGate } from "./gate-stages";
import type { Reporter, IHandoff, EscalationRung } from "../loop.types";
import { slicesToFeatures, invalidEntityIds } from "./plan-resources";
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
  IAcceptanceOutcome,
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
 *  feature adds its NavLink (required for reachability) the count changes and this test fails.
 *  The fast per-feature gate RUNS this test — the boringstack gate appends `bun run test -- run
 *  … src/components/core/AppSidebar` (see gate.ts), added so a stale count surfaces IN-LOOP with
 *  feedback rather than only at the FINAL full-project validate (where a fully-verified feature
 *  would otherwise leave the build "stuck"). The scaffold is an external clone we can't edit, so
 *  the model must keep this test in sync: scope it in and instruct (refinePrompt) to bump the
 *  expected link count by its one added link — nothing else. */
export const APP_SIDEBAR_TEST_FILE =
  "apps/ui/src/components/core/AppSidebar/AppSidebar.test.tsx";

/**
 * The feature-EXCLUSIVE directories the model may FULLY REWRITE — its own API resource, its API
 * tests, and its UI feature. These are safe rewrite targets because no other feature owns them.
 * Distinct from the shared ADD-ONLY files (schema/locale/sidebar/routes/sidebar-test) that
 * `scopeFor` also grants edit access to: those are add-only and must NEVER be named for a wholesale
 * rewrite (it would clobber sibling features), so the parse-error locator uses ONLY these globs.
 */
export function featureOwnedGlobs(name: string): string[] {
  const camel = toCamelCase(name);

  return [
    `apps/api/src/api/${camel}/**`,
    `apps/api/tests/api/${camel}/**`,
    `apps/ui/src/features/${camel}/**`,
  ];
}

export function scopeFor(name: string): string[] {
  return [
    ...featureOwnedGlobs(name),
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
 * Read the generated resource code from the filesystem for the completeness judge.
 * Concatenates the API resource (.ts) and UI feature (.ts/.tsx/.jsx, test/story files
 * excluded) source, capped at ~96000 characters. React components (.tsx/.jsx) are ordered
 * FIRST across both apps so a large API can't exhaust the budget before the judge sees the
 * UI. Returns empty string if directories don't exist.
 */
export async function readResourceCode(
  cwd: string,
  name: string
): Promise<string> {
  const camel = toCamelCase(name);
  // Budget must fit a full feature (API + UI components + hooks) so the completeness
  // JUDGE actually sees the code. 16000 truncated real features mid-UI, which made the
  // judge reject a code-green feature forever ("component truncated, cannot verify") —
  // an unfixable-by-the-model wall. The models here carry ≥1M-token context, so a
  // generous char budget is safe.
  const maxChars = 96000;

  // Gather every candidate file (API + UI) BEFORE truncating, so ordering is global.
  // A React COMPONENT (.tsx/.jsx) is what the judge most needs to verify the UI, so
  // components come FIRST regardless of app — otherwise a large API resource could
  // exhaust the budget before any component is read, reproducing the "component not
  // shown" false-rejection this budget was raised to prevent.
  const candidates: { relPath: string; fullPath: string }[] = [];

  // Normalize the OS path separator to "/" so relPath (and therefore the codepoint
  // ordering below) is IDENTICAL on POSIX and Windows — a recursive readdir yields
  // "a\b.tsx" on Windows vs "a/b.tsx" on POSIX, and "\" (0x5C) vs "/" (0x2F) sort
  // differently against other chars, which would make the truncation boundary
  // machine-dependent.
  const norm = (f: string): string => f.replaceAll("\\", "/");
  // Co-located test/story files are not part of the feature under review — they waste
  // the judge's budget (and could expose test-only behavior as production context).
  // Applied to BOTH apps. Covers .test/.spec/.story/.stories suffixes AND __tests__ dirs.
  const isTestFile = (rel: string): boolean =>
    /\.(test|spec|stor(?:y|ies))\.[jt]sx?$/u.test(rel) ||
    /(?:^|\/)__tests__\//u.test(rel);

  const apiDir = join(cwd, "apps/api/src/api", camel);

  try {
    const apiFiles = await readdir(apiDir, { recursive: false });

    for (const file of apiFiles) {
      if (typeof file !== "string" || !file.endsWith(".ts")) {
        continue;
      }

      const rel = norm(file);

      if (isTestFile(rel)) {
        continue;
      }

      candidates.push({
        relPath: `apps/api/src/api/${camel}/${rel}`,
        fullPath: join(apiDir, file),
      });
    }
  } catch {
    // Directory doesn't exist, skip
  }

  const uiDir = join(cwd, "apps/ui/src/features", camel);

  try {
    const uiFiles = await readdir(uiDir, { recursive: true });

    for (const file of uiFiles) {
      // Include .tsx/.jsx — the React COMPONENTS (Page/Form) live in .tsx. A `.ts`-only
      // filter dropped every component, so the completeness judge never saw the UI it was
      // asked to verify.
      if (
        typeof file !== "string" ||
        !(
          file.endsWith(".ts") ||
          file.endsWith(".tsx") ||
          file.endsWith(".jsx")
        )
      ) {
        continue;
      }

      const rel = norm(file);

      if (isTestFile(rel)) {
        continue;
      }

      candidates.push({
        relPath: `apps/ui/src/features/${camel}/${rel}`,
        fullPath: join(uiDir, file),
      });
    }
  } catch {
    // Directory doesn't exist, skip
  }

  // Components (.tsx/.jsx) first, GLOBALLY — a large API must not starve the judge of the
  // UI. Same-rank files are then ordered by path so the selection is DETERMINISTIC: readdir
  // returns entries in an unspecified, filesystem-dependent order, so tiebreaking on
  // insertion order would let truncation include different files across machines/runs and
  // give the judge inconsistent context. A lexicographic path tiebreak fixes the order.
  const rank = (relPath: string): number =>
    relPath.endsWith(".tsx") || relPath.endsWith(".jsx") ? 0 : 1;
  // Codepoint comparison (NOT localeCompare) for the same-rank tiebreak: localeCompare
  // depends on the runtime locale + ICU build, so it can order paths differently across
  // machines — which would reintroduce the non-determinism this tiebreak exists to remove.
  // A plain `<`/`>` is identical everywhere for these paths. (It compares UTF-16 units,
  // not code points, and the separator normalization above assumes no literal backslash in
  // a POSIX filename — both are non-issues here: boringstack feature files are generated
  // with ASCII kebab/camel names, never astral chars or embedded backslashes.)
  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = [...candidates].sort((a, b) => {
    const byRank = rank(a.relPath) - rank(b.relPath);

    return byRank === 0 ? byPath(a.relPath, b.relPath) : byRank;
  });

  const blocks: string[] = [];
  let totalLen = 0;

  for (const { relPath, fullPath } of ordered) {
    const content = await readFile(fullPath, "utf-8");
    const block = `// ${relPath}\n${content}\n`;

    if (totalLen + block.length > maxChars) {
      blocks.push(`\n…[truncated]`);
      break;
    }

    blocks.push(block);
    totalLen += block.length;
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
 * On any `done:false` it also returns a `reason` naming WHY the feature can't be marked done, so the
 * outer loop's park message is truthful (fast-gate ladder exhaustion vs e2e-acceptance failure vs
 * misconfiguration) instead of always claiming "ladder exhausted". Exported for unit testing.
 */
export async function verifyAcceptance(
  sent: { status: string; handoff?: IHandoff },
  host: IBoringstackHost,
  cwd: string,
  entity: IEntityAcceptance | undefined,
  acceptanceRunner: IAcceptanceRunner | undefined,
  e2eAcceptanceDisabled: boolean,
  fullSpec?: IAcceptanceSpec
): Promise<{
  done: boolean;
  handoff?: IHandoff;
  infra?: string;
  reason?: string;
}> {
  // If acceptance is not enabled, return based on fast gate
  if (!(!e2eAcceptanceDisabled && sent.status === "done")) {
    const done = sent.status === "done";

    return {
      done,
      ...(sent.handoff !== undefined ? { handoff: sent.handoff } : {}),
      ...(done
        ? {}
        : { reason: "fast gate not green after the escalation ladder" }),
    };
  }

  // FAIL-CLOSED: if acceptance is enabled and entity exists but runner is missing,
  // this is a misconfiguration — reject the feature until the runner is injected
  if (entity && !acceptanceRunner) {
    return {
      done: false,
      reason:
        "e2e acceptance enabled but no runner configured (harness misconfiguration)",
    };
  }

  // Run acceptance only if we have an entity and runner
  if (entity && acceptanceRunner) {
    return runE2eAcceptance(host, cwd, entity, acceptanceRunner, fullSpec);
  }

  return {
    done: true,
    ...(sent.handoff !== undefined ? { handoff: sent.handoff } : {}),
  };
}

/**
 * Drive the per-slice browser acceptance for a feature whose fast gate is already green:
 * run it, on failure emit the steer + re-run once, and report done + a truthful `reason`.
 * Split out of verifyAcceptance to keep each function's cognitive complexity in bounds.
 */
async function runE2eAcceptance(
  host: IBoringstackHost,
  cwd: string,
  entity: IEntityAcceptance,
  acceptanceRunner: IAcceptanceRunner,
  fullSpec?: IAcceptanceSpec
): Promise<{
  done: boolean;
  handoff?: IHandoff;
  infra?: string;
  reason?: string;
}> {
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

  // All checks passed on the first run.
  if (outcome.ok) {
    return { done: true };
  }

  // Test assertion failed: emit steer, re-verify, and close over post-steer state.
  const steerSend = await host.send(acceptanceSteer(entity, outcome));

  // Re-run acceptance once to see if the fix worked.
  const reRun = await acceptanceRunner.run(entity, ctx, fullSpec);

  // If the re-run is an infra error, route it through the needs-infra channel.
  if (reRun.infraError !== undefined) {
    return { done: false, infra: reRun.infraError };
  }

  // done:true ONLY when both the steer completed AND the re-run passed.
  const done = steerSend.status === "done" && reRun.ok;

  return {
    done,
    ...(steerSend.handoff !== undefined ? { handoff: steerSend.handoff } : {}),
    ...(done
      ? {}
      : {
          reason: e2eParkReason(steerSend.status === "done", outcome, reRun),
        }),
  };
}

/**
 * Compose the truthful park reason for a feature whose fast gate was GREEN but e2e
 * acceptance did not confirm. Pure + unit-tested. The three done:false shapes:
 *  - re-run still failing (steer complete)   → still failing after the steer
 *  - re-run still failing (steer incomplete) → still failing AND the steer stalled
 *  - re-run PASSED but steer incomplete      → the app verified; only the steer stalled
 *    (crucially NOT a stale "assertions failed" — that was the pre-steer state).
 * Prefers the CURRENT (post-steer) failing detail; falls back to the pre-steer detail only
 * when the re-run itself surfaced none.
 */
export function e2eParkReason(
  steerComplete: boolean,
  outcome: IAcceptanceOutcome,
  reRun: IAcceptanceOutcome
): string {
  const nonEmpty = (s: string | undefined): string | undefined =>
    s !== undefined && s.length > 0 ? s : undefined;
  const failingDetail = (o: IAcceptanceOutcome): string | undefined =>
    // Prefer the top-level detail (but treat a BLANK top-level detail as absent — `"" ?? x`
    // keeps "", which would suppress a real step detail), then the first failing result that
    // actually carries a non-empty detail — not merely the first failing result, whose detail
    // may be blank while a later failing step holds the real diagnostic.
    nonEmpty(o.detail) ??
    o.results.find((r) => !r.ok && r.detail.length > 0)?.detail;

  if (!reRun.ok) {
    // Prefer the CURRENT (post-steer) diagnostic; only if the re-run surfaced none fall back
    // to the pre-steer outcome — including ITS step details, not just its top-level detail.
    const detail =
      failingDetail(reRun) ??
      failingDetail(outcome) ??
      "browser acceptance assertions failed";

    return steerComplete
      ? `fast gate green but e2e acceptance still failing after the fix steer: ${detail}`
      : `fast gate green but e2e acceptance still failing AND the fix steer did not complete: ${detail}`;
  }

  // The re-run PASSED — the app verified. Parked only because the steer itself stalled;
  // report exactly that, never a stale assertion failure.
  return "fast gate green and e2e acceptance passed on re-run, but the fix steer did not complete cleanly";
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
  /** Wire the post-login redirect for the plan's `home` slice. Injectable so the implement()
   *  wiring is unit-testable; defaults to the real filesystem writer. */
  applyHomeRedirect?: (cwd: string, route: string) => Promise<void>;
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
    applyHomeRedirect: applyHomeRedirectFn,
    sliceFor,
    acceptanceRunner,
    fullSpec,
  } = opts;
  const generate = generateFn ?? generateResource;
  const genUi = generateUi ?? generateFeature;
  const wireHomeRedirectFor = applyHomeRedirectFn ?? applyHomeRedirect;
  const baseline = opts.baseline ?? new Set<string>();
  const e2eAcceptanceDisabled =
    process.env[ENV_FLAG.noE2eAcceptance] === FLAG_ON;

  return {
    async implement(
      feature: IFeature,
      state: IGreenfieldState,
      seed?: { triedLevers: EscalationRung[] }
    ): Promise<{
      done: boolean;
      handoff?: IHandoff;
      infra?: string;
      reason?: string;
    }> {
      // Pre-step: generate the full vertical slice + sync the STUB schema. The
      // model then fills the domain INSIDE the loop, checked by the live gate.
      await generate(cwd, feature.id, exec);
      await genUi(cwd, feature.id, exec);

      // Deterministically point the post-login landing at the app "home" feature's route (plan
      // `ui.home`) — harness-owned, NOT model-prompted, so the landing can't silently stay
      // `/dashboard` and slip past the gate (a false-green). No-op for non-home features.
      if (sliceFor?.(feature.id)?.ui.home === true) {
        await wireHomeRedirectFor(cwd, `/${toCamelCase(feature.id)}`);
      }

      host.setScope(scopeFor(feature.id));
      // The editable file the expert repairs if a stall's errors are all out of
      // scope (locked consumers of this feature's types) — its service file.
      host.setExpertRescueTarget((await rescueFileFor(cwd, feature)) ?? "");
      // NOTE: no db:push here — `generate` above IS generateResource, which already
      // runs the headless-safe `dbPushForce` (recover-or-throw) on every attempt, and
      // the gate's command stage re-pushes (with the same recovery + short-circuit)
      // each cycle. A second push here would be redundant and, if it ignored its
      // result, could re-introduce the swallowed-failure false-green this fix removes.

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

/** The persisted pristine baseline: the differential gate's reference. `signatures` are
 *  the failure signatures already present on the PRISTINE scaffold, which feature grading
 *  EXCLUDES (the model is judged only on failures it introduces). `passed` is whether the
 *  pristine gate itself was GREEN — persisted SEPARATELY, never inferred from an empty
 *  signature set: a RED gate whose output didn't parse into known signatures is ALSO
 *  `signatures: []` but `passed: false`, and must NOT be re-announced GREEN on resume. */
export interface IPersistedBaseline {
  readonly passed: boolean;
  readonly signatures: ReadonlySet<string>;
}

/** Where the pristine-scaffold baseline is persisted — beside the greenfield checklist,
 *  so a fresh build's reset (which clears `.tsforge/greenfield`) also drops it, while a
 *  RESUME keeps it. */
function baselinePath(cwd: string): string {
  return join(greenfieldDir(cwd), "baseline.json");
}

/** Load the persisted pristine baseline, or null if none exists / it's unreadable / it's
 *  the wrong shape — never trust a corrupt file. What the caller does with null depends on
 *  the tree: a genuine FRESH build (no greenfield checklist) re-captures + persists; a RESUME
 *  (checklist present) grades STRICT and does NOT re-capture (the tree is no longer pristine).
 *  Requires the `{ passed, signatures }` object shape with a string[] `signatures`; else null. */
export async function loadBaseline(
  cwd: string
): Promise<IPersistedBaseline | null> {
  try {
    const raw = await readFile(baselinePath(cwd), "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("passed" in parsed) ||
      !("signatures" in parsed) ||
      typeof parsed.passed !== "boolean" ||
      !Array.isArray(parsed.signatures) ||
      !parsed.signatures.every((s) => typeof s === "string")
    ) {
      return null;
    }

    return { passed: parsed.passed, signatures: new Set(parsed.signatures) };
  } catch {
    return null;
  }
}

/** Persist the pristine baseline so a later RESUME reuses it instead of re-capturing.
 *  Re-capturing on resume is the bug this fixes: the resume tree is NON-pristine (it holds
 *  the in-progress feature's code), so a fresh capture sweeps that feature's OWN failures
 *  into the baseline and EXCLUDES them from grading — a false-green (feature verified while
 *  it still fails its own gate). Persisting the FIRST (pristine) capture — BOTH its passed
 *  bit and its signatures — and reusing it keeps grading honest across resumes. */
export async function saveBaseline(
  cwd: string,
  baseline: IPersistedBaseline
): Promise<void> {
  await mkdir(greenfieldDir(cwd), { recursive: true });
  await writeFile(
    baselinePath(cwd),
    `${JSON.stringify({ passed: baseline.passed, signatures: [...baseline.signatures] }, null, 2)}\n`
  );
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

  // A failed FINAL acceptance is ALWAYS terminal — never downgraded to a green pass.
  // `finalPassed` is false only when (a) the FULL gate (validate/build/size/root-drift)
  // failed, or (b) the browser CHAIN acceptance failed. Case (b) can only occur when
  // acceptance is enabled (the chain is skipped otherwise), so when the flag is set the
  // only way here is (a) — a real full-gate red. `TSFORGE_NO_E2E_ACCEPTANCE` must skip
  // ONLY the browser/chain e2e; it must NOT make the full gate advisory (that was a
  // gate-relaxation false-green: a failed full gate returned "done" — 4-model panel P0a).
  if (!finalPassed) {
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

  // Fail fast on a malformed entity id BEFORE any generation: each id becomes file
  // paths, the `<camel>Routes` mount identifier, i18n keys, and test ids, so a
  // non-identifier id (e.g. "Purchase Order") otherwise breaks generation deep
  // downstream with an opaque error. The planner is only prompted for PascalCase and
  // the plan validator checks merely non-empty, so enforce the identifier contract here.
  const badIds = invalidEntityIds(approved.slices);

  if (badIds.length > 0) {
    throw new Error(
      `Plan has invalid entity id(s): ${badIds.map((id) => JSON.stringify(id)).join(", ")}. ` +
        `Each entity id must be a PascalCase identifier — letter-first, alphanumeric only ` +
        `(e.g. "Invoice", "PurchaseOrder") — because it becomes generated file paths, the ` +
        `<id>Routes mount identifier, i18n keys, and test ids. Fix the plan's entity id(s) and retry.`
    );
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

  // Capture the BASELINE gate for differential feature grading — the model is judged only
  // on failures IT introduces, never on pre-existing scaffold defects it's frozen out of.
  // The baseline MUST come from the PRISTINE tree; it is captured ONCE on a fresh build and
  // PERSISTED (with its pass/fail bit), and a RESUME reuses it. Re-capturing on a resume
  // runs the gate on the ALREADY-MODIFIED tree and sweeps the in-progress feature's OWN
  // failures into the baseline (then EXCLUDES them from grading) — a false-green where a
  // feature "verifies" while still failing its own gate (live-observed). The gate STILL runs
  // every invocation — it is the fail-closed needs-infra check below — but on a resume its
  // captured signatures are DISCARDED in favour of the persisted ones.
  onEvent?.({
    kind: "tool",
    task: "boringstack",
    message: "running the baseline gate (infra check + pristine capture)…",
  });

  const baseRun = await runBoringstackGate(cwd, exec);
  const fresh: IBaselinePartition = baseRun.passed
    ? { infra: [], baseline: new Set<string>() }
    : partitionBaseline(extractFailures(baseRun.output, cwd));

  const infra = fresh.infra;

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

  // Choose the GRADING baseline (infra is healthy here — the fail-closed above returned):
  //  - a persisted baseline exists → REUSE it (the pristine capture; carries its own passed
  //    bit — NEVER inferred from an empty set, which would re-announce a RED-unparseable
  //    pristine gate as GREEN).
  //  - else a genuine FRESH start (no greenfield checklist yet ⇒ pristine tree) → use THIS
  //    capture and persist it.
  //  - else a RESUME with no persisted baseline (a build started before this shipped, or a
  //    lost file) → the tree is NON-pristine, so this capture is CONTAMINATED. Grade STRICTLY
  //    (empty baseline — every failure counts, only ever over-strict, never a false-green)
  //    and warn; do NOT freeze the contaminated capture in.
  const persisted = await loadBaseline(cwd);
  // A resume is ANY prior greenfield checklist ON DISK — detected by FILE PRESENCE
  // (`hasState`), NOT by `loadState !== null`. `loadState` returns null for a missing
  // file AND for a present-but-corrupt one, so using it would treat a corrupt-state
  // resume (whose tree WAS already built into) as a fresh start and persist a
  // CONTAMINATED baseline (a false-green). build.ts never writes the checklist before
  // this point, so a genuine fresh build has no file here; mere PRESENCE (even an empty
  // or unparseable checklist) means the tree is no longer pristine. Erring toward
  // "resume" is only ever over-strict, never a false-green.
  const isResume = await hasState(cwd);

  let baseline: ReadonlySet<string>;
  let baselinePassed: boolean;
  // Whether THIS invocation is on the pristine tree (the fresh capture). Only then may we
  // trust the tree for the differential command baseline AND the meta-rule baseline; on a
  // resume both are reused-or-strict, never re-captured from the contaminated tree.
  let isFreshCapture = false;
  // The RED-unparseable / GREEN / RED-with-signatures report describes a PRISTINE capture.
  // The strict fallback below has no pristine result (missing baseline.json on a non-pristine
  // resume), so it must NOT emit that report — it emits its own warning instead.
  let hasPristineReport = true;

  if (persisted !== null) {
    baseline = persisted.signatures;
    baselinePassed = persisted.passed;
    onEvent?.({
      kind: "tool",
      task: "boringstack",
      message: `reusing the persisted pristine baseline (${String(persisted.signatures.size)} signature(s), ${persisted.passed ? "GREEN" : "RED"}) — resume, NOT re-captured`,
    });
  } else if (!isResume) {
    baseline = fresh.baseline;
    baselinePassed = baseRun.passed;
    isFreshCapture = true;
    await saveBaseline(cwd, {
      passed: baseRun.passed,
      signatures: fresh.baseline,
    });
  } else {
    baseline = new Set<string>();
    baselinePassed = false;
    hasPristineReport = false;
    onEvent?.({
      kind: "stuck",
      task: "boringstack",
      message:
        "⚠ resuming without a persisted pristine baseline (older build or lost baseline.json) — " +
        "the tree is no longer pristine, so grading falls back to STRICT (nothing excluded). " +
        "Reset + rebuild to restore a clean differential baseline.",
    });
  }

  if (hasPristineReport) {
    const report = describeBaseline(baselinePassed, baseline.size);

    onEvent?.({
      kind: report.kind,
      task: "boringstack",
      message: report.message,
    });
  }

  // Capture the PRISTINE meta-rule baseline too (workflow perms, lockfile, etc. that
  // the model is frozen out of) — but ONLY on a fresh capture, for the SAME reason the
  // command baseline is only captured fresh. `captureMetaBaseline` reads the CURRENT
  // tree; on a resume that tree is contaminated, so re-capturing would sweep meta
  // violations introduced before the interruption into the baseline and EXCLUDE them
  // from grading — the same contaminated-resume false-green, for the meta gate. On a
  // resume the session's meta-baseline stays unset ⇒ STRICT (nothing subtracted), which
  // is the safe direction and makes the strict-fallback warning above truthful. (Meta
  // violations on a clean scaffold are empty anyway, so the common case is unchanged.)
  if (isFreshCapture) {
    host.captureMetaBaseline();
  }

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
