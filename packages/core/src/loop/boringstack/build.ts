import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  IGreenfieldDeps,
  IFeature,
  IGreenfieldState,
  IGreenfieldResult,
  IGreenfieldOptions,
} from "../greenfield/greenfield.types";
import { evaluateFeature } from "../greenfield/evaluate";
import type {
  IEvaluateDeps,
  IGateOutcome,
  IJudgeOutcome,
} from "../greenfield/evaluate";
import { judgeFeature } from "../greenfield/judge";
import type { IProvider } from "../../inference";
import type { Exec } from "./exec";
import { generateResource, generateFeature } from "./generate";
import { runBoringstackGate } from "./gate";
import { extractFailures, novelFailures } from "./extract-failures";
import {
  resolveExpertAsk,
  resolveStuckFile,
  runExpertHandoff,
} from "../expert-handoff";
import { refinePrompt } from "./refine-prompt";
import { runGreenfield, prepareState } from "../greenfield/run";
import type { Reporter } from "../loop.types";
import { planResources } from "./plan-resources";
import { toCamelCase } from "./case";

/** Apply BoringStack's DETERMINISTIC auto-fixes over both apps before the gate:
 *  `format` (prettier, canonical formatting) then `lint:fix` (eslint --fix for the
 *  auto-fixable lint rules prettier can't touch — padding-line, import order, etc.).
 *  Neither changes logic, so neither should ever cost the model a gate attempt — a
 *  dev gets both on save. Best-effort: a missing script or non-zero exit is ignored;
 *  the gate stays the source of truth. */
async function autofixApps(cwd: string, exec: Exec): Promise<void> {
  for (const app of ["apps/api", "apps/ui"]) {
    const appCwd = join(cwd, app);

    await exec(["bun", "run", "format"], { cwd: appCwd });
    await exec(["bun", "run", "lint:fix"], { cwd: appCwd });
  }
}

/**
 * Generate the scope globs for a resource: the files the model is allowed to edit
 * for this feature.
 */
export function scopeFor(name: string): string[] {
  const camel = toCamelCase(name);

  return [
    `apps/api/src/api/${camel}/**`,
    `apps/api/tests/api/${camel}/**`,
    `apps/ui/src/features/${camel}/**`,
  ];
}

/**
 * Read the generated resource code from the filesystem.
 * Concatenates TypeScript files from both the API resource and UI feature directories,
 * capped at ~16000 characters. Returns empty string if directories don't exist.
 */
async function readResourceCode(cwd: string, name: string): Promise<string> {
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
  send(message: string): Promise<{ status: string; turns: number }>;
}

/**
 * Create the greenfield dependencies for the BoringStack build, composing Tasks 1-5.
 * - `implement` generates the resource, freezes the scope, and sends the refine prompt.
 * - `evaluate` runs the layered evaluator (gate → browser → judge).
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
}): IGreenfieldDeps {
  const { host, cwd, exec, evaluator, generate: generateFn, generateUi } = opts;
  const generate = generateFn ?? generateResource;
  const genUi = generateUi ?? generateFeature;
  const baseline = opts.baseline ?? new Set<string>();

  return {
    async implement(
      feature: IFeature,
      _state: IGreenfieldState
    ): Promise<void> {
      // Generate the FULL vertical slice: API resource (Drizzle+Elysia) then the
      // UI feature. generateFeature runs `generate:api`, syncing the UI's typed
      // OpenAPI client — without this the root drift check ("OpenAPI drift") fails.
      await generate(cwd, feature.id, exec);
      await genUi(cwd, feature.id, exec);

      // Freeze the scope to this resource's files
      host.setScope(scopeFor(feature.id));

      // Task 5: Send the refined prompt to the model
      const prompt = refinePrompt(feature);

      await host.send(prompt);

      // Apply BoringStack's deterministic auto-fixes (prettier + eslint --fix) to
      // the model's edits BEFORE the gate. These classes are 100% auto-fixable and
      // shouldn't cost the model an attempt — a dev gets them on save. Only genuine
      // (non-auto-fixable) violations reach the gate as feedback.
      await autofixApps(cwd, exec);
    },

    async evaluate(feature: IFeature, _state: IGreenfieldState) {
      const evaluateDeps: IEvaluateDeps = {
        // Task 3: Run the deterministic gate — DIFFERENTIAL against the baseline.
        // A truly-green gate passes outright. A red gate passes ONLY if every
        // failure is a pre-existing baseline failure (the feature added nothing
        // broken); otherwise it fails with ONLY the new failures as feedback, so
        // the model never chases base-suite defects it's frozen out of.
        async gate(_f: IFeature): Promise<IGateOutcome> {
          const result = await runBoringstackGate(cwd, exec);

          if (result.passed) {
            return { passed: true, output: result.output };
          }

          const current = extractFailures(result.output, cwd);
          const novel = novelFailures(current, baseline);

          // Pass-despite-red ONLY when we PARSED failures and every one is a
          // baseline failure. An empty parse on a non-zero exit means we can't
          // prove the redness is baseline-only (unrecognized output / a
          // build-step crash) — stay failed and hand back the raw output.
          if (current.size > 0 && novel.length === 0) {
            return {
              passed: true,
              output:
                `gate exit non-zero, but every failure is a pre-existing baseline ` +
                `failure (${String(baseline.size)}) the feature cannot touch — no ` +
                `new failures introduced.`,
            };
          }

          if (novel.length > 0) {
            return {
              passed: false,
              output:
                `NEW failures introduced by this feature ` +
                `(${String(novel.length)}; ${String(baseline.size)} baseline ` +
                `failure(s) hidden):\n${novel.join("\n")}`,
            };
          }

          return { passed: false, output: result.output };
        },

        // Skip browser check (playwright not available in BoringStack)
        async browser(_f: IFeature) {
          return Promise.resolve({
            ok: true,
            errors: [],
            skipped: true,
          });
        },

        // Task 4: Judge the implementation quality
        async judge(_f: IFeature): Promise<IJudgeOutcome> {
          const code = await readResourceCode(cwd, feature.id);

          return await judgeFeature(evaluator, {
            feature: feature.desc,
            code,
          });
        },
      };

      return evaluateFeature(feature, evaluateDeps);
    },

    // Expert rescue: the rung above the per-attempt feedback loop. Before a stuck
    // feature parks, hand its failing file + exact errors to the configured
    // `capabilities.expert` model (a stronger model — the automated version of "a
    // human steps in"). Opt-in via TSFORGE_EXPERT_RESCUE (the expert is typically a
    // paid API); when off or unconfigured, `resolveExpertAsk` returns null and this
    // is a no-op → the feature parks exactly as before.
    async rescue(feature: IFeature): Promise<boolean> {
      const ask = await resolveExpertAsk();

      if (ask === null) {
        return false;
      }

      const lastError = feature.lastError ?? "";

      if (lastError.trim().length === 0) {
        return false;
      }

      const file = await resolveStuckFile(cwd, [{ message: lastError }]);

      if (file === null) {
        return false;
      }

      const content = await Bun.file(join(cwd, file))
        .text()
        .catch(() => null);

      if (content === null) {
        return false;
      }

      const outcome = await runExpertHandoff(
        cwd,
        { file, content, error: lastError, goal: feature.desc },
        ask
      );

      if (!outcome.applied) {
        return false;
      }

      // Re-apply the deterministic auto-fixes over the expert's file before the
      // final re-evaluation, same as an ordinary attempt.
      await autofixApps(cwd, exec);

      return true;
    },
  };
}

/**
 * Run the BoringStack build driver: plan resources and drive them through the
 * greenfield loop (implement → evaluate → persist).
 */
export async function runBoringstackBuild(opts: {
  cwd: string;
  goal: string;
  evaluator: IProvider;
  exec: Exec;
  host: IBoringstackHost;
  onEvent?: Reporter;
}): Promise<IGreenfieldResult> {
  const { cwd, goal, evaluator, exec, host, onEvent } = opts;

  // Task 1: Plan resources from the goal
  const state = await prepareState(cwd, goal, (g: string) =>
    planResources(evaluator, g).then((features) =>
      features.length > 0 ? { spec: goal, features } : null
    )
  );

  if (state === null) {
    return { status: "done", features: [] };
  }

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

  onEvent?.({
    kind: baseline.size > 0 ? "stuck" : "tool",
    task: "boringstack",
    message:
      baseline.size > 0
        ? `⚠ baseline scaffold is RED: ${String(baseline.size)} pre-existing gate ` +
          `failure(s) EXCLUDED from feature grading (differential gate). The app ` +
          `won't be fully green until the scaffold baseline is fixed.`
        : "baseline scaffold is GREEN — features graded against a clean gate.",
  });

  // Run the greenfield loop with BoringStack-specific dependencies
  const optsGreenfield: IGreenfieldOptions = {};

  if (onEvent) {
    optsGreenfield.onEvent = onEvent;
  }

  return runGreenfield(
    cwd,
    state,
    boringstackDeps({ host, cwd, exec, evaluator, baseline }),
    optsGreenfield
  );
}
