import { runWizard } from "../render/wizard";
import type {
  IWizardState,
  IWizardStep,
  IWizardView,
} from "../render/wizard.types";
import {
  buildScaffoldSteps,
  stateToAnswers,
  runScaffold,
  makeScaffoldRunDeps,
  loadScaffoldSource,
  loadBundledManifest,
  formatScaffoldHandoff,
  isArchetype,
} from "../scaffold";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface IReplScaffoldDeps {
  /** Base directory the new project folder is created UNDER (the REPL's cwd). */
  readonly cwd: string;
  readonly suspend: () => void;
  readonly resume: () => void;
  readonly out: (s: string) => void;
  /** Pane overlay — when set, scaffold wizards skip nested alt-screen. */
  readonly view?: IWizardView;
  /** Overlay width. Prefer main-pane inner cols when the pane console is live. */
  readonly columns?: number;
  /** Max overlay rows. Prefer pane chrome budget when panes are live. */
  readonly viewportRows?: number;
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

/** Single-select step offering archetype choices: boringstack, astro, phaser. */
export function archetypeStep(): IWizardStep {
  return {
    key: "archetype",
    kind: "single",
    title: "Choose a project type",
    reviewTitle: "Project type",
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
        label: "Phaser",
        value: "phaser",
        note: "Phaser 4 + TS game (Vite, scenes as views)",
      },
    ],
    defaultIndex: 0,
  };
}

/** Show a step only for one archetype (and any extra predicate, e.g. askWhen). */
function whenArchetype(
  id: string,
  inner?: (state: IWizardState) => boolean
): (state: IWizardState) => boolean {
  return (state) =>
    state.single.archetype === id && (inner === undefined || inner(state));
}

/**
 * One REPL scaffold wizard: project type, then directory, then archetype-specific
 * questions. Phaser/Astro have no extra config — picking Phaser goes to the
 * folder name, not a Review that re-asks "Choose a project type".
 */
export function buildReplScaffoldSteps(
  stack: "dev" | "prod" | "smoke" = "dev"
): readonly IWizardStep[] {
  const config = buildScaffoldSteps(
    loadBundledManifest(),
    "boringstack",
    stack
  ).map((step) => ({
    ...step,
    visibleWhen: whenArchetype("boringstack", step.visibleWhen),
  }));

  return [
    archetypeStep(),
    projectDirStep(),
    {
      ...superuserEmailStep(),
      visibleWhen: whenArchetype("boringstack"),
    },
    {
      ...superuserPasswordStep(),
      visibleWhen: whenArchetype("boringstack"),
    },
    ...config,
  ];
}

/** Free-text step: the initial superuser (admin) login email. boringstack only —
 *  seeded when the stack first boots. Blank = skip (no superuser seeded). */
function superuserEmailStep(): IWizardStep {
  return {
    key: "superuserEmail",
    kind: "text",
    title: "Admin email (optional)",
    explanation:
      "Email for the initial admin account, seeded when the stack first boots. Leave blank to skip and sign up in-app instead.",
    evidence: [],
    options: [],
    placeholder: "admin@example.com",
    validate: (v) =>
      v.length === 0 || /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(v)
        ? null
        : "Enter a valid email address, or leave blank to skip.",
  };
}

/** Masked free-text step: the initial superuser password (boringstack only). */
function superuserPasswordStep(): IWizardStep {
  return {
    key: "superuserPassword",
    kind: "text",
    mask: true,
    title: "Admin password (optional)",
    explanation:
      "Password for the initial admin account (min 12 characters). Leave blank to skip.",
    evidence: [],
    options: [],
    placeholder: "••••••••••••",
    validate: (v) =>
      v.length === 0 || v.length >= 12
        ? null
        : "Use at least 12 characters, or leave blank to skip.",
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

/** Print the handoff card shown after a successful scaffold. */
function printHandoff(
  out: (s: string) => void,
  dir: string,
  resolvedSha: string,
  booted: boolean,
  bootError: string | undefined,
  summary: readonly string[],
  archetype: string
): void {
  out(
    formatScaffoldHandoff(
      {
        dir,
        sha: resolvedSha,
        booted,
        summary,
        archetype,
        interactive: true,
        ...(bootError === undefined ? {} : { bootError }),
      },
      process.stdout.isTTY
    )
  );
}

/**
 * Launch the in-REPL scaffold wizard: project type, folder name, then any
 * archetype-specific questions (one Review at the end). Phaser has no extra
 * config — choosing it does not re-ask the project type.
 * Suspends the editor during the wizard and resumes in a finally block.
 */
export async function openScaffoldInRepl(
  deps: IReplScaffoldDeps,
  // Injection seam for tests: the real scaffold runner by default. A test drives the
  // wizard and passes a fake to verify progress (onPhase) reaches deps.out — without
  // a real clone/boot.
  run: typeof runScaffold = runScaffold
): Promise<string | null> {
  deps.suspend();

  try {
    const color = process.stdout.isTTY;

    const wizardOpts = {
      title: "tsforge scaffold",
      manageInput: false,
      out: deps.out,
      ...(deps.view === undefined ? {} : { view: deps.view }),
      ...(deps.columns === undefined ? {} : { columns: deps.columns }),
      ...(deps.viewportRows === undefined
        ? {}
        : { viewportRows: deps.viewportRows }),
    };

    const stack = "dev";
    const steps = buildReplScaffoldSteps(stack);
    const state = await runWizard(steps, color, wizardOpts);

    if (state.status !== "apply") {
      deps.out("scaffold: cancelled — nothing was created.\n");

      return null;
    }

    const selectedArchetype = state.single.archetype ?? "";

    if (!isArchetype(selectedArchetype)) {
      deps.out("scaffold: cancelled — unknown project type.\n");

      return null;
    }

    const archetype = selectedArchetype;
    const manifest = loadScaffoldSource(archetype);

    // Resolve the destination folder (under cwd, validated, non-existent).
    const resolved = resolveScaffoldDest(deps.cwd, state.text.projectDir ?? "");

    if ("error" in resolved) {
      deps.out(`scaffold: ${resolved.error} — nothing was created.\n`);

      return null;
    }

    const { dest } = resolved;

    // Convert state to answers, folding in the optional superuser (only when
    // BOTH email + password were given — the seed needs a complete credential pair).
    const base = stateToAnswers(manifest, archetype, stack, state);
    const suEmail = state.text.superuserEmail ?? "";
    const suPassword = state.text.superuserPassword ?? "";
    const answers =
      suEmail.length > 0 && suPassword.length > 0
        ? { ...base, superuser: { email: suEmail, password: suPassword } }
        : base;

    return await scaffoldFromAnswers(manifest, answers, dest, deps.out, run);
  } finally {
    deps.resume();
  }
}

/**
 * Run the scaffold from collected answers and report to `out`: forward each phase
 * as a "  → …" progress line (via makeScaffoldRunDeps), print the handoff, and note
 * the boringstack planning next-step. Extracted from openScaffoldInRepl so the
 * run+progress+handoff wiring is testable without driving the interactive wizard.
 */
export async function scaffoldFromAnswers(
  manifest: Parameters<typeof runScaffold>[0],
  answers: Parameters<typeof runScaffold>[1],
  dest: string,
  out: (s: string) => void,
  run: typeof runScaffold = runScaffold
): Promise<string | null> {
  try {
    const outcome = await run(
      manifest,
      answers,
      dest,
      makeScaffoldRunDeps(out)
    );

    printHandoff(
      out,
      outcome.dir,
      outcome.resolvedSha,
      outcome.booted,
      outcome.bootError,
      outcome.summary,
      answers.archetype
    );

    return outcome.dir;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    out(`scaffold failed: ${message}\n`);

    return null;
  }
}
