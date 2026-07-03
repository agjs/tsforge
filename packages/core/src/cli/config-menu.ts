import { STYLE, paint } from "../render/style";
import { runOwnedMenu } from "../render/owned-menu";
import type {
  IMenuRow,
  IOwnedMenuDeps,
  IOwnedMenuSelectControl,
} from "../render/owned-menu";
import {
  loadModelsConfig,
  saveModelsConfig,
  setActiveModel,
} from "../models-config";
import type { IModelEntry, IModelsConfig } from "../models-config";

/**
 * `/config` — the in-harness settings hub. Everything a user can reasonably
 * change, each with a one-line description and its live value, editable without
 * touching docs or JSON. Runs as ONE owned-stdin session (a menu loop with inline
 * text entry) — NOT nested wizards — so it never fights the REPL editor for input
 * (the nesting caused a keystroke leak + a quit-on-cancel bug).
 *
 * Reads are live; changes apply immediately (and persist where they have a home:
 * models.json for the registry, process env for feature flags this session,
 * the session object for gate/scope/mode).
 */

// ── setting model ────────────────────────────────────────────────────────────

export interface IField {
  readonly key: string;
  readonly label: string;
  readonly default?: string;
  readonly mask?: boolean;
  readonly validate?: (value: string) => string | null;
}

export interface ISetting {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  /** One line shown under the selection — the in-TUI "docs". */
  readonly describe: string;
  /** Current value, rendered next to the label. */
  read(): string;
  /** choice/toggle: apply immediately (cycle / flip). Omitted for text actions. */
  activate?(): void | Promise<void>;
  /** text action: fields to collect, then applied by `applyText`. */
  readonly fields?: readonly IField[];
  applyText?(values: Readonly<Record<string, string>>): void | Promise<void>;
}

/** Everything the settings need from the running session/CLI (injected so the
 *  builders stay pure + testable). */
export interface IConfigDeps {
  readonly color: boolean;
  /** Detach/re-attach the REPL editor around this session. */
  readonly suspend: () => void;
  readonly resume: () => void;
  /** Hot-swap the running provider to an entry. */
  readonly reconfigure: (entry: IModelEntry) => void;
  /** The active model's display name, and a hook to record a change (status bar). */
  readonly currentModelName: () => string;
  readonly onModelChange: (name: string) => void;
  /** Interactive mode. */
  readonly currentMode: () => string;
  readonly setMode: (id: string) => void;
  /** Gate + editable scope (session-level). */
  readonly getGate: () => string;
  readonly setGate: (cmd: string) => void;
  readonly getScope: () => string;
  readonly setScope: (globs: string) => void;
  /** Feature flags — read/written via env (flags read env live, so this takes
   *  effect for subsequent turns this session). */
  readonly getEnv: (name: string) => string | undefined;
  readonly setEnv: (name: string, value: string | undefined) => void;
}

const NON_EMPTY = (label: string) => (v: string) =>
  v.trim().length === 0 ? `${label} is required` : null;

// ── pure model-registry helpers (unit-tested) ───────────────────────────────

/** The add-model input fields. */
export function addModelFields(): IField[] {
  return [
    { key: "name", label: "Name", validate: NON_EMPTY("Name") },
    {
      key: "baseUrl",
      label: "Base URL",
      default: "http://localhost:8000/v1",
      validate: NON_EMPTY("Base URL"),
    },
    { key: "model", label: "Model", validate: NON_EMPTY("Model") },
    { key: "apiKey", label: "API key (optional)", mask: true },
  ];
}

/** Turn add-model answers into a { name, entry } pair (pure). */
export function draftToEntry(values: Readonly<Record<string, string>>): {
  name: string;
  entry: IModelEntry;
} {
  const apiKey = (values.apiKey ?? "").trim();

  return {
    name: (values.name ?? "").trim(),
    entry: {
      baseUrl: (values.baseUrl ?? "").trim(),
      model: (values.model ?? "").trim(),
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

/** The name after `current` in the registry, wrapping — for "cycle active model". */
export function nextModelName(cfg: IModelsConfig, current: string): string {
  const names = Object.keys(cfg.models);

  if (names.length === 0) {
    return current;
  }

  const i = names.indexOf(current);

  return names[(i + 1) % names.length] ?? current;
}

// ── the settings list (comprehensive, each with a description) ───────────────

const ENV = {
  web: "TSFORGE_WEB",
  tdd: "TSFORGE_TDD",
};

function onOff(on: boolean): string {
  return on ? "on" : "off";
}

/** Clamp a value to one line — a gate command / long scope must never wrap the
 *  menu (it blows the whole layout out otherwise). */
const VALUE_MAX = 52;

export function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();

  return flat.length <= VALUE_MAX ? flat : `${flat.slice(0, VALUE_MAX - 1)}…`;
}

/** Build the settings hub. Model entries hit disk (loadModelsConfig etc.); the
 *  rest read/write the injected session + env. */
export function buildSettings(deps: IConfigDeps): ISetting[] {
  return [
    {
      id: "model.active",
      group: "Model",
      label: "Active model",
      describe: "The model tsforge talks to. Cycles through your models.json.",
      read: () => deps.currentModelName(),
      activate: async () => {
        const cfg = await loadModelsConfig();
        const name = nextModelName(cfg, cfg.active);
        const next = await setActiveModel(name);
        const entry = next.models[name];

        if (entry !== undefined) {
          deps.reconfigure(entry);
          deps.onModelChange(name);
        }
      },
    },
    {
      id: "model.add",
      group: "Model",
      label: "Add a model",
      describe: "Register a new endpoint + model and make it active.",
      read: () => "…",
      fields: addModelFields(),
      applyText: async (values) => {
        const { name, entry } = draftToEntry(values);
        const cfg = await loadModelsConfig();

        await saveModelsConfig(addModel(cfg, name, entry));
        deps.reconfigure(entry);
        deps.onModelChange(name);
      },
    },
    {
      id: "mode",
      group: "Behavior",
      label: "Mode",
      describe:
        "plan = explore read-only and propose a plan first; normal = act directly.",
      read: () => deps.currentMode(),
      activate: () => {
        deps.setMode(deps.currentMode() === "plan" ? "normal" : "plan");
      },
    },
    {
      id: "gate",
      group: "Behavior",
      label: "Gate command",
      describe:
        "Command that must pass for a task to count as done (empty = none).",
      read: () => {
        const g = deps.getGate();

        return g.length === 0 ? "(none)" : g;
      },
      fields: [{ key: "gate", label: "Gate command (empty to clear)" }],
      applyText: (values) => {
        deps.setGate((values.gate ?? "").trim());
      },
    },
    {
      id: "scope",
      group: "Behavior",
      label: "Editable scope",
      describe:
        "Which files the agent may edit (comma-separated globs; empty = all).",
      read: () => deps.getScope(),
      fields: [{ key: "scope", label: "Scope globs (empty = whole repo)" }],
      applyText: (values) => {
        deps.setScope((values.scope ?? "").trim());
      },
    },
    {
      id: "tools.web",
      group: "Tools",
      label: "Web tools",
      describe:
        "web_fetch + web_search (DuckDuckGo, no key). Applies to new turns this session.",
      read: () => onOff(deps.getEnv(ENV.web) === "1"),
      activate: () => {
        const on = deps.getEnv(ENV.web) === "1";

        deps.setEnv(ENV.web, on ? undefined : "1");
      },
    },
    {
      id: "tools.tdd",
      group: "Tools",
      label: "TDD enforcement",
      describe:
        "Require a test sibling for changed logic (test-first). On by default.",
      read: () => onOff(deps.getEnv(ENV.tdd) !== "0"),
      activate: () => {
        const on = deps.getEnv(ENV.tdd) !== "0";

        deps.setEnv(ENV.tdd, on ? "0" : undefined);
      },
    },
  ];
}

// ── interactive driver: owned-menu + edit sub-loop ──────────────────────────

interface IEditState {
  readonly setting: ISetting;
  readonly fieldIndex: number;
  readonly values: Record<string, string>;
}

interface IKeyInfo {
  readonly name?: string;
  readonly ctrl?: boolean;
}

function currentField(edit: IEditState): IField {
  return edit.setting.fields?.[edit.fieldIndex] ?? { key: "", label: "" };
}

function fieldError(edit: IEditState): string | null {
  const field = currentField(edit);
  const value = edit.values[field.key] ?? "";

  return field.validate === undefined ? null : field.validate(value);
}

// ── rendering (pure) ─────────────────────────────────────────────────────────

export function renderMenu(
  settings: ISetting[],
  cursor: number,
  color: boolean
): string {
  const rows: string[] = [];
  let group = "";

  settings.forEach((s, i) => {
    if (s.group !== group) {
      group = s.group;
      rows.push("", paint(group, STYLE.bold, color));
    }

    const active = i === cursor;
    const gutter = active ? paint("›", STYLE.brand, color) : " ";
    const label = paint(s.label, active ? STYLE.brand : STYLE.bold, color);
    const value = paint(oneLine(s.read()), STYLE.brandLight, color);

    rows.push(`${gutter} ${label}  ${paint("·", STYLE.dim, color)} ${value}`);
    rows.push(`    ${paint(s.describe, STYLE.dim, color)}`);
  });

  return [
    paint("tsforge config", STYLE.brand, color),
    `${paint("Settings", STYLE.bold, color)} · change anything here`,
    "─".repeat(52),
    ...rows,
    "",
    paint("↑/↓ move   enter change   esc done", STYLE.dim, color),
  ].join("\n");
}

function renderEdit(edit: IEditState, color: boolean): string {
  const field = currentField(edit);
  const raw = edit.values[field.key] ?? "";
  const shown = field.mask === true ? "•".repeat(raw.length) : raw;
  const error = fieldError(edit);
  const total = edit.setting.fields?.length ?? 1;

  return [
    paint("tsforge config", STYLE.brand, color),
    `${paint(edit.setting.label, STYLE.bold, color)} · field ${edit.fieldIndex + 1} of ${total}`,
    "─".repeat(52),
    field.label,
    `  ${shown}${paint("▏", STYLE.brand, color)}`,
    ...(error === null ? [] : ["", paint(error, STYLE.yellow, color)]),
    "",
    paint("type   enter next   esc cancel", STYLE.dim, color),
  ].join("\n");
}

// ── the driver ───────────────────────────────────────────────────────────────

const ESC = String.fromCharCode(27);
const CLEAR_HOME = `${ESC}[2J${ESC}[H`;

/**
 * Run the settings hub interactively via runOwnedMenu. The edit sub-loop
 * (for text-field settings) is managed in onSelect by pausing the main loop.
 */
export function runConfigMenu(deps: IConfigDeps): Promise<void> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return Promise.resolve();
  }

  const settings = buildSettings(deps);
  let editState: IEditState | null = null;

  const out = (s: string): void => {
    process.stdout.write(s);
  };

  const drawEdit = (): void => {
    if (editState === null) {
      return;
    }

    out(`${CLEAR_HOME}${renderEdit(editState, deps.color)}`);
  };

  const handleEditKey = (
    str: string | undefined,
    key: IKeyInfo,
    onEditDone: () => void
  ): void => {
    if (editState === null) {
      return;
    }

    const field = currentField(editState);

    if (key.name === "return") {
      const error = fieldError(editState);

      if (error !== null) {
        return;
      }

      const fields = editState.setting.fields ?? [];

      if (editState.fieldIndex + 1 < fields.length) {
        editState = { ...editState, fieldIndex: editState.fieldIndex + 1 };
        drawEdit();
      } else {
        const values = editState.values;
        const setting = editState.setting;

        editState = null;
        void Promise.resolve(setting.applyText?.(values))
          .then(onEditDone)
          .catch(onEditDone);
      }
    } else if (key.name === "escape") {
      editState = null;
      onEditDone();
    } else if (key.name === "backspace") {
      editState.values[field.key] = (editState.values[field.key] ?? "").slice(
        0,
        -1
      );
      drawEdit();
    } else if (str?.length === 1 && str >= " " && str <= "~") {
      editState.values[field.key] =
        `${editState.values[field.key] ?? ""}${str}`;
      drawEdit();
    }
  };

  const menuRows = (): readonly IMenuRow[] => {
    return settings.map((s) => ({
      group: s.group,
      label: s.label,
      describe: s.describe,
      value: oneLine(s.read()),
    }));
  };

  const onSelect = async (
    index: number,
    control: IOwnedMenuSelectControl
  ): Promise<void> => {
    const setting = settings[index];

    if (setting === undefined) {
      return;
    }

    if (setting.fields === undefined) {
      await Promise.resolve(setting.activate?.());

      return;
    }

    const values: Record<string, string> = {};

    for (const f of setting.fields) {
      values[f.key] = f.default ?? "";
    }

    editState = { setting, fieldIndex: 0, values };
    control.pause();
    drawEdit();

    return new Promise((resolveEdit) => {
      const editHandler = (str: string | undefined, key: IKeyInfo): void => {
        try {
          handleEditKey(str, key, () => {
            editState = null;
            stdin.off("keypress", editHandler);
            control.resume();
            resolveEdit();
          });
        } catch {
          editState = null;
          stdin.off("keypress", editHandler);
          control.resume();
          resolveEdit();
        }
      };

      stdin.on("keypress", editHandler);
    });
  };

  const ownedMenuDeps: IOwnedMenuDeps = {
    color: deps.color,
    title: "tsforge config",
    subtitle: `${paint("Settings", STYLE.bold, deps.color)} · change anything here`,
    footer: "↑/↓ move   enter change   esc done",
    suspend: deps.suspend,
    resume: deps.resume,
    rows: menuRows,
    onSelect,
  };

  return runOwnedMenu(ownedMenuDeps);
}
