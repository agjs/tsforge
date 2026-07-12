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
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface IReplScaffoldDeps {
  /** Base directory the new project folder is created UNDER (the REPL's cwd). */
  readonly cwd: string;
  readonly suspend: () => void;
  readonly resume: () => void;
  readonly out: (s: string) => void;
}

/** Free-text step: the folder name for the new project (created under cwd). */
function projectDirStep(): IWizardStep {
  return {
    key: "projectDir",
    kind: "text",
    title: "Project directory",
    explanation:
      "Folder name for the new project (created in the current directory).",
    evidence: [],
    options: [],
    placeholder: "my-app",
  };
}

/** Single-select step offering archetype choices: boringstack, astro. */
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
    ],
    defaultIndex: 0,
  };
}

/** Resolve the scaffold destination from a user-typed folder name: a plain name
 *  under `cwd`, rejecting empties, path separators, and traversal (no escaping the
 *  workspace), and refusing to overwrite an existing directory. Pure enough to test
 *  (only touches the filesystem to check existence). */
export function resolveScaffoldDest(
  cwd: string,
  rawName: string
): { readonly dest: string } | { readonly error: string } {
  const name = rawName.trim();

  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..")
  ) {
    return { error: "a plain project directory name is required" };
  }

  const dest = join(cwd, name);

  if (existsSync(dest)) {
    return { error: `${dest} already exists — pick another name` };
  }

  return { dest };
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

    // Boringstack/Astro: run the full flow
    const archetype =
      selectedArchetype === "boringstack" ? "boringstack" : "astro";
    const stack = "dev";

    // Step 2: project directory name + the archetype's configuration steps.
    const configSteps = buildScaffoldSteps(manifest, archetype, stack);
    const configState = await runWizard(
      [projectDirStep(), ...configSteps],
      color,
      {
        title: "tsforge scaffold",
        manageInput: false,
        out: deps.out,
      }
    );

    if (configState.status !== "apply") {
      deps.out("scaffold: cancelled — nothing was created.\n");

      return;
    }

    // Resolve the destination folder (under cwd, validated, non-existent).
    const resolved = resolveScaffoldDest(
      deps.cwd,
      configState.text.projectDir ?? ""
    );

    if ("error" in resolved) {
      deps.out(`scaffold: ${resolved.error} — nothing was created.\n`);

      return;
    }

    const { dest } = resolved;

    // Step 3: Convert state to answers
    const answers = stateToAnswers(manifest, archetype, stack, configState);

    try {
      const outcome = await runScaffold(manifest, answers, dest, {
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
