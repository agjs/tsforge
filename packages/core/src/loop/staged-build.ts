/**
 * The staged from-scratch build (design the type contract → implement against
 * it), extracted from Session so the phase orchestration is unit-testable
 * against a fake host. The host interface is the narrow seam Session exposes:
 * gate/tool swapping, one send, one full-gate probe, and one raw completion.
 */
import { readFiles } from "../lib/fs";
import type { Reporter } from "./loop.types";
import type { ISendOptions, ISendResult } from "./session";

/** What the staged build needs from its session. */
export interface IStagedBuildHost {
  /** The working directory (where the designed contract files live). */
  readonly cwd: string;
  /** The task id used in report events. */
  readonly taskId: string;
  /** The session's CURRENT gate command (task.accept). */
  readonly gate: string;
  setGate(command: string): void;
  /** Swap to the design-phase tool set (withholds the app-building scaffold
   *  tools so the model CANNOT start the UI in phase 1). */
  useDesignTools(): void;
  /** Restore the tool set that was active before useDesignTools(). */
  useFullTools(): void;
  send(message: string, opts?: ISendOptions): Promise<ISendResult>;
  /** Run the FULL gate once; true when it passes. */
  fullGatePasses(): Promise<boolean>;
  /** One completion over the live conversation (no tools; deterministic). */
  completeOnce(prompt: string): Promise<string>;
  report: Reporter;
}

/** Staged-build step 1: design the type contract FIRST, gate off. Constraining
 *  the model to types before UI is the community-validated cure for random API
 *  invention on local models (plan → interfaces → implementation). */
const PLAN_TYPES_STEP =
  "STEP 1 of 2 — DESIGN FIRST, do not build the UI yet. In ONE short paragraph, " +
  "name the DOMAINS the app needs and the data each holds. Then lay out the type " +
  "contract the boringstack way: for each domain create its " +
  "`src/<domain>/<domain>.types.ts` (its interfaces — bare PascalCase names like " +
  "`Deal`, no `I` prefix) and, where it has " +
  "fixed registries/config, `src/<domain>/<domain>.constants.ts` (`as const`). Put " +
  "types shared across domains in `src/shared/shared.types.ts`. Do NOT create one " +
  "mega `src/types.ts`. THIS STEP IS TYPES/CONSTANTS ONLY: do NOT create components, " +
  "routes, services, seeds, or hooks, and do NOT call scaffold_routes or scaffold_ui " +
  "yet — the NEXT step builds ALL of that. This phase's gate checks ONLY types (no " +
  "build), so anything else you write now just risks errors and wastes turns. When " +
  "your `.types.ts`/`.constants.ts` files type-check, STOP.\n" +
  "SPEED: after the one-paragraph plan, write MANY files per turn — emit SEVERAL " +
  "`create` tool calls in a SINGLE response (batch all of a domain's type/constant " +
  "files at once). Do NOT write one file then stop and wait.";

/** Plan mode — emitted AFTER the design phase to surface the model's intent for a
 *  human to review before phase 2 commits. Asks for a concise plan, NOT code. */
const PLAN_SUMMARY_STEP =
  "Before building the UI, output your BUILD PLAN as concise markdown so it can be " +
  "reviewed. Cover, briefly:\n" +
  "1. ENTITIES — list each, and for each say whether it gets its OWN routes " +
  "(list/detail/create) or is NESTED/EMBEDDED in another (say where).\n" +
  "2. ROUTES/PAGES — the routes you will create.\n" +
  "3. DONE — what you consider a complete app for this spec.\n" +
  "4. DECISIONS/ASSUMPTIONS — any modeling choices a reviewer might want to change.\n" +
  "Output ONLY the markdown plan — no preamble, no tool calls, no code.";

/** Staged-build step 2: implement against the contract, gate on (drive to green). */
const IMPLEMENT_STEP =
  "STEP 2 of 2 — build the app in THIS ORDER, so every file compiles the moment " +
  "you write it (each step depends only on earlier ones — no forward references):\n" +
  "1) DATA — each domain's types (<feature>.types.ts) + typed seed/constants " +
  "(<feature>.constants.ts), e.g. `export const SEED = [...] satisfies readonly " +
  "Thing[]` (plain literals, no `as`). Need async? Write your OWN hook in " +
  "<feature>.hooks.ts (react-query/fetch), narrowing the response. Small files; " +
  "emit them together.\n" +
  "2) ROUTES — call `scaffold_routes` ONCE with EVERY page the app needs (list, " +
  "detail with $param like /accounts/$accountId, and create/edit like " +
  "/deals/create). This writes all route files at once, so from here every " +
  "<Link to>/navigate target type-checks — NEVER hand-write a route file.\n" +
  "3) SHELL — the app-shell layout + nav linking those routes.\n" +
  "4) FILL, FEATURE BY FEATURE — replace each route's placeholder with its real " +
  "view (list/detail/forms wired to the seed data), one feature at a time, " +
  "keeping the gate green as you go.";

/** The globs the design phase writes and the implement phase re-reads. */
export const CONTRACT_GLOBS: readonly string[] = [
  "src/**/*.types.ts",
  "src/**/*.constants.ts",
];

/** All source files, scanned to decide whether phase 1 already BUILT the app. */
const IMPLEMENTATION_GLOBS: readonly string[] = ["src/**/*.ts", "src/**/*.tsx"];

/** True when `path` is real app IMPLEMENTATION — NOT a type/constant declaration,
 *  a generated/test file, a scaffolded UI primitive, or the entry point. This is
 *  what distinguishes "phase 1 over-delivered and built the whole app" (skip the
 *  rebuild) from "phase 1 wrote only the type contract" — the NORMAL case, where
 *  the empty scaffold still compiles, so the gate is green yet nothing is built. */
export function isImplementationFile(path: string): boolean {
  const base = path.split("/").pop() ?? "";

  if (/\.(types|constants|d|gen|test)\.tsx?$/u.test(base)) {
    return false;
  }

  if (path.includes("/components/ui/")) {
    return false; // scaffolded theme primitives, not app code
  }

  return base !== "main.ts" && base !== "main.tsx";
}

/** Whether any of `paths` is real app implementation (see isImplementationFile). */
export function hasImplementation(paths: readonly string[]): boolean {
  return paths.some(isImplementationFile);
}

/** Format the designed `.types.ts`/`.constants.ts` files as a precise reference
 *  block for the implement phase — so the model builds against the EXACT current
 *  signatures instead of its (lossy) recollection of them. Empty string when
 *  nothing exists yet (nothing to anchor). Pure; unit-tested. */
export function formatTypeContract(
  files: readonly { path: string; content: string }[]
): string {
  if (files.length === 0) {
    return "";
  }

  const blocks = files
    .map((f) => `// ${f.path}\n${f.content.trim()}`)
    .join("\n\n");

  return (
    "THE TYPE CONTRACT you just designed (use these EXACT names/shapes — do " +
    "NOT invent or misremember fields; import from these paths):\n\n```ts\n" +
    `${blocks}\n` +
    "```\n\n"
  );
}

/**
 * Build a project from scratch in two STAGES, the way local models stay
 * reliable: (1) plan + write the type contract with the gate OFF — a types-only
 * app can't build yet, so gating here would spuriously fail; (2) implement
 * against those types with the gate ON, driving to green. This is the
 * community-validated plan→interfaces→implementation pattern; our gate is
 * the verification stage. A soft constraint: if the model ignores step 1 and
 * builds everything, step 2 simply continues — nothing breaks.
 */
export async function buildStaged(
  host: IStagedBuildHost,
  request: string,
  opts: ISendOptions = {},
  designGate = ""
): Promise<ISendResult> {
  const planned = await designBuild(host, request, opts, designGate);

  // Don't push on to implementation if the user aborted the design step.
  if (planned.status === "interrupted") {
    return planned;
  }

  return implementBuild(host, "", opts);
}

/**
 * PHASE 1 — design the type contract only. Gates on TYPES (tsc + lint, no build)
 * when a `designGate` is given, so the contract is driven self-consistent BEFORE
 * components (catching as-const↔interface errors small, not as a final pile).
 * Withholds the app-building scaffold tools so the model CANNOT start the UI here
 * — a prompt-only "types only" was repeatedly ignored. Returns the phase-1 result
 * and leaves the session ready for `implementBuild`. Split out from `buildStaged`
 * so plan mode can insert a human review between the phases.
 */
export async function designBuild(
  host: IStagedBuildHost,
  request: string,
  opts: ISendOptions = {},
  designGate = ""
): Promise<ISendResult> {
  const gate = host.gate;

  host.setGate(designGate);
  host.useDesignTools();

  const planned = await host.send(`${request}\n\n${PLAN_TYPES_STEP}`, opts);

  host.useFullTools();
  host.setGate(gate);

  return planned;
}

/**
 * PHASE 2 — implement against the designed types, driving to green. If phase 1
 * already BUILT the app (it ignored "types only" and built everything) AND it is
 * green, this returns done WITHOUT rebuilding — else the model concludes the
 * prior phase did "only the data layer" and `rm -rf`s its own finished UI to
 * rebuild (observed: 23-00-52 went green at turn 146, then phase 2 wiped every
 * file). CRUCIAL: the skip demands REAL implementation files, not just a green
 * gate — a types-only phase 1 leaves the empty scaffold, which trivially passes
 * typecheck+lint+build, so skipping on green ALONE shipped a hollow app (all
 * `*.types.ts`, no code; the model announced "Ready for STEP 2" and got cut off).
 * `planNotes` (human plan-mode edits) are injected into the implement step.
 */
export async function implementBuild(
  host: IStagedBuildHost,
  planNotes = "",
  opts: ISendOptions = {}
): Promise<ISendResult> {
  // Cheap check first: did phase 1 write any real implementation? In the normal
  // types-only flow it did not, so we skip the (expensive) gate probe and go
  // straight to building. Only when the model over-delivered do we confirm green
  // and skip the rebuild.
  const built = hasImplementation(
    (await readFiles(host.cwd, IMPLEMENTATION_GLOBS)).map((f) => f.path)
  );

  if (built && (await host.fullGatePasses())) {
    host.report({
      kind: "tool",
      task: host.taskId,
      message:
        "phase 1 already built a fully-green app — skipping phase 2 (no rebuild)",
    });

    return { status: "done", turns: 0 };
  }

  // Inject the EXACT type contract the design phase just wrote, fresh, right
  // before implementation. The model's #1 first-pass error is misremembering its
  // OWN types across many files/turns (a field shape it defined 30 turns ago) —
  // re-showing the precise current signatures cuts those consistency errors (so
  // less repair).
  const contract = formatTypeContract(
    await readFiles(host.cwd, CONTRACT_GLOBS)
  );
  const notes =
    planNotes.length > 0
      ? `\n\n## Approved plan — follow these decisions\n${planNotes}\n`
      : "";

  return host.send(`${contract}${IMPLEMENT_STEP}${notes}`, opts);
}

/**
 * Plan mode — after `designBuild`, ask the model to state its build PLAN as
 * markdown (entities + whether each is its own route or nested/embedded; the
 * routes/pages it will create; what it considers DONE; key modeling decisions)
 * so a human can review/correct it BEFORE phase 2 commits ~100 turns. A single
 * completion over the live conversation; emits NO tool calls and touches no
 * files. Returns the plan text (empty string if the model returned nothing).
 */
export async function generatePlan(host: IStagedBuildHost): Promise<string> {
  return (await host.completeOnce(PLAN_SUMMARY_STEP)).trim();
}
