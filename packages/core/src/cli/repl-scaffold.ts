import { runWizard } from "../render/wizard";
import type { IWizardStep } from "../render/wizard.types";
import {
  buildScaffoldSteps,
  stateToAnswers,
  runScaffold,
  loadBundledManifest,
  realFs,
  realRunner,
  realPoller,
} from "../scaffold";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IReplScaffoldDeps {
  readonly suspend: () => void;
  readonly resume: () => void;
  readonly out: (s: string) => void;
}

/** Single-select step offering three archetype choices: boringstack, astro, vite. */
export function archetypeStep(): IWizardStep {
  return {
    key: "archetype",
    kind: "single",
    title: "Choose a project type",
    explanation: "What would you like to scaffold?",
    evidence: [],
    options: [
      {
        label: "Boringstack",
        value: "boringstack",
        note: "Full Bun+Elysia+Drizzle+React stack",
      },
      {
        label: "Astro",
        value: "astro",
        note: "Static site generator",
      },
      {
        label: "Vite",
        value: "vite",
        note: "Lightweight frontend project",
      },
    ],
    defaultIndex: 0,
  };
}

/** Print the handoff block shown after a successful scaffold. */
function printHandoff(
  out: (s: string) => void,
  dir: string,
  resolvedSha: string,
  booted: boolean,
  bootError: string | undefined,
  summary: readonly string[]
): void {
  const gateDir = dir; // In REPL, gateCwd is the root dir (no subPath logic needed here)
  const gateCmd = "bun run validate"; // Default gate for boringstack/astro

  out(
    [
      "",
      `scaffold ready → ${dir}`,
      `  cloned   ${resolvedSha}`,
      `  booted   ${String(booted)}${bootError === undefined ? "" : ` (${bootError})`}`,
      "",
      "configured .env:",
      ...summary.map((l) => `  ${l}`),
      "",
      "build it:",
      `  tsforge --dir ${gateDir} --accept '${gateCmd}' "<your first feature>"`,
      "",
    ].join("\n")
  );
}

/** Print the vite handoff message and return. */
function handoffVite(out: (s: string) => void): void {
  out(
    [
      "",
      "To scaffold a Vite project, run:",
      `  tsforge --web "<your first feature>"`,
      "",
    ].join("\n")
  );
}

/**
 * Launch the in-REPL scaffold wizard: pick an archetype (boringstack/astro/vite),
 * then run the full flow for boringstack/astro or handoff to --web for vite.
 * Suspends the editor during the wizard and resumes in a finally block.
 */
export async function openScaffoldInRepl(
  deps: IReplScaffoldDeps
): Promise<void> {
  deps.suspend();

  try {
    const color = process.stdout.isTTY;
    const manifest = loadBundledManifest();

    // Step 1: Run archetype selection wizard
    const archetypeState = await runWizard([archetypeStep()], color, {
      title: "tsforge scaffold",
      manageInput: false,
      out: deps.out,
    });

    if (archetypeState.status !== "apply") {
      deps.out("scaffold: cancelled — nothing was created.\n");

      return;
    }

    const selectedArchetype = archetypeState.single.archetype;

    // Vite: print handoff and return
    if (selectedArchetype === "vite") {
      handoffVite(deps.out);

      return;
    }

    // Boringstack/Astro: run the full flow
    const archetype =
      selectedArchetype === "boringstack" ? "boringstack" : "astro";
    const stack = "dev";

    // Step 2: Run configuration steps for the chosen archetype
    const configSteps = buildScaffoldSteps(manifest, archetype, stack);
    const configState = await runWizard(configSteps, color, {
      title: "tsforge scaffold",
      manageInput: false,
      out: deps.out,
    });

    if (configState.status !== "apply") {
      deps.out("scaffold: cancelled — nothing was created.\n");

      return;
    }

    // Step 3: Convert state to answers
    const answers = stateToAnswers(manifest, archetype, stack, configState);

    // Create temp directory for the scaffold
    const tmpDir = mkdtempSync(join(tmpdir(), "tsforge-scaffold-"));

    try {
      const outcome = await runScaffold(manifest, answers, tmpDir, {
        run: realRunner,
        fs: realFs,
        boot: { poll: realPoller },
      });

      printHandoff(
        deps.out,
        outcome.dir,
        outcome.resolvedSha,
        outcome.booted,
        outcome.bootError,
        outcome.summary
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      deps.out(`scaffold failed: ${message}\n`);
    }
  } finally {
    deps.resume();
  }
}
