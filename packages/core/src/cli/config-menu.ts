import {
  loadModelsConfig,
  saveModelsConfig,
  setActiveModel,
} from "../models-config";
import type { IModelEntry, IModelsConfig } from "../models-config";
import { runWizard } from "../render/wizard";
import type { IWizardStep } from "../render/wizard.types";

/**
 * `/config` — the in-harness settings menu. v1 manages the model registry
 * (switch the active model, or add one) so users never hand-edit
 * `~/.tsforge/models.json`. Built on the generic wizard (its text steps power
 * "add a model"); more groups (mode, feature toggles) slot in later.
 *
 * The pure builders + `addModel` are unit-tested; the interactive `runConfigCommand`
 * is exercised by a real-pty e2e.
 */

const NON_EMPTY = (label: string) => (v: string) =>
  v.trim().length === 0 ? `${label} is required` : null;

/** The top-level action picker (single-select; picking applies immediately). */
export function buildConfigMenu(currentModel: string): IWizardStep {
  return {
    key: "action",
    kind: "single",
    title: "Settings",
    explanation: "What would you like to configure?",
    evidence: [],
    options: [
      {
        label: "Switch model",
        value: "switch-model",
        outcome: `Change the active model (now: ${currentModel}).`,
      },
      {
        label: "Add a model",
        value: "add-model",
        outcome: "Register a new endpoint + model, and make it active.",
      },
    ],
  };
}

/** Single-select of the configured model names, defaulting to the active one. */
export function buildModelPickStep(cfg: IModelsConfig): IWizardStep {
  const names = Object.keys(cfg.models);

  return {
    key: "model",
    kind: "single",
    title: "Active model",
    explanation: "Pick the model to use.",
    evidence: [],
    options: names.map((name) => {
      const entry = cfg.models[name];

      return {
        label: name,
        value: name,
        note: entry === undefined ? "" : `${entry.model} @ ${entry.baseUrl}`,
      };
    }),
    defaultIndex: Math.max(0, names.indexOf(cfg.active)),
  };
}

/** The "add a model" text-input flow. */
export function buildAddModelSteps(): IWizardStep[] {
  const text = (
    key: string,
    title: string,
    explanation: string,
    extra: Partial<IWizardStep> = {}
  ): IWizardStep => ({
    key,
    kind: "text",
    title,
    explanation,
    evidence: [],
    options: [],
    ...extra,
  });

  return [
    text("name", "Name", "A short id for this entry (used by /model).", {
      placeholder: "my-model",
      validate: NON_EMPTY("Name"),
    }),
    text("baseUrl", "Base URL", "The OpenAI-compatible API root.", {
      default: "http://localhost:8000/v1",
      validate: NON_EMPTY("Base URL"),
    }),
    text("model", "Model", "The model id sent in requests.", {
      placeholder: "qwen3.6-27b",
      validate: NON_EMPTY("Model"),
    }),
    text("apiKey", "API key", "Optional — leave empty for local endpoints.", {
      mask: true,
    }),
  ];
}

/** Turn the add-model answers into a { name, entry } pair (pure). */
export function draftToEntry(text: Readonly<Record<string, string>>): {
  name: string;
  entry: IModelEntry;
} {
  const apiKey = (text.apiKey ?? "").trim();

  return {
    name: (text.name ?? "").trim(),
    entry: {
      baseUrl: (text.baseUrl ?? "").trim(),
      model: (text.model ?? "").trim(),
      ...(apiKey.length > 0 ? { apiKey } : {}),
    },
  };
}

/** Add (or replace) an entry and make it active — pure, returns the next config. */
export function addModel(
  cfg: IModelsConfig,
  name: string,
  entry: IModelEntry
): IModelsConfig {
  return { active: name, models: { ...cfg.models, [name]: entry } };
}

export interface IConfigDeps {
  readonly color: boolean;
  readonly activeName: string;
  /** Detach/re-attach the REPL editor from stdin around the wizard. */
  readonly suspend: () => void;
  readonly resume: () => void;
  /** Hot-swap the running provider to the given entry. */
  readonly reconfigure: (entry: IModelEntry) => void;
}

const TITLE = "tsforge config";

async function addModelFlow(deps: IConfigDeps): Promise<string | null> {
  const answers = await runWizard(buildAddModelSteps(), deps.color, {
    title: TITLE,
  });

  if (answers.status !== "apply") {
    return null;
  }

  const { name, entry } = draftToEntry(answers.text);
  const cfg = await loadModelsConfig();

  await saveModelsConfig(addModel(cfg, name, entry));
  deps.reconfigure(entry);

  return name;
}

async function switchModelFlow(deps: IConfigDeps): Promise<string | null> {
  const cfg = await loadModelsConfig();
  const picked = await runWizard([buildModelPickStep(cfg)], deps.color, {
    title: TITLE,
    review: false,
  });

  if (picked.status !== "apply") {
    return null;
  }

  const name = picked.single.model ?? "";
  const next = await setActiveModel(name);
  const entry = next.models[name];

  if (entry !== undefined) {
    deps.reconfigure(entry);
  }

  return name;
}

/**
 * Run the `/config` menu interactively. Suspends the REPL editor for the wizard's
 * lifetime (so it doesn't fight the keypress loop), then resumes. Returns the new
 * active model name when it changed, else null (cancelled / no change).
 */
export async function runConfigCommand(
  deps: IConfigDeps
): Promise<{ activeName: string } | null> {
  deps.suspend();

  try {
    const menu = await runWizard(
      [buildConfigMenu(deps.activeName)],
      deps.color,
      {
        title: TITLE,
        review: false,
      }
    );

    if (menu.status !== "apply") {
      return null;
    }

    const name =
      menu.single.action === "add-model"
        ? await addModelFlow(deps)
        : await switchModelFlow(deps);

    return name === null ? null : { activeName: name };
  } finally {
    deps.resume();
  }
}
