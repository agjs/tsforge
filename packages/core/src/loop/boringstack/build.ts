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
import { refinePrompt } from "./refine-prompt";
import { runGreenfield, prepareState } from "../greenfield/run";
import type { Reporter } from "../loop.types";
import { planResources } from "./plan-resources";
import { toCamelCase } from "./case";

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
  generate?: (cwd: string, name: string, exec: Exec) => Promise<void>;
  generateUi?: (cwd: string, name: string, exec: Exec) => Promise<void>;
}): IGreenfieldDeps {
  const { host, cwd, exec, evaluator, generate: generateFn, generateUi } = opts;
  const generate = generateFn ?? generateResource;
  const genUi = generateUi ?? generateFeature;

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
    },

    async evaluate(feature: IFeature, _state: IGreenfieldState) {
      const evaluateDeps: IEvaluateDeps = {
        // Task 3: Run the deterministic gate
        async gate(_f: IFeature): Promise<IGateOutcome> {
          const result = await runBoringstackGate(cwd, exec);

          return { passed: result.passed, output: result.output };
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

  // Run the greenfield loop with BoringStack-specific dependencies
  const optsGreenfield: IGreenfieldOptions = {};

  if (onEvent) {
    optsGreenfield.onEvent = onEvent;
  }

  return runGreenfield(
    cwd,
    state,
    boringstackDeps({ host, cwd, exec, evaluator }),
    optsGreenfield
  );
}
