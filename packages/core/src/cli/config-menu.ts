import { emitKeypressEvents } from "node:readline";
import { STYLE, paint } from "../render/style";
import { clampIndex } from "../render/command-menu";
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
  noScript: "TSFORGE_NO_SCRIPT",
  noUpdateCheck: "TSFORGE_NO_UPDATE_CHECK",
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
    {
      id: "tools.script",
      group: "Tools",
      label: "Script tool",
      describe: "Programmatic tool calling for multi-file work. On by default.",
      read: () => onOff(deps.getEnv(ENV.noScript) !== "1"),
      activate: () => {
        const on = deps.getEnv(ENV.noScript) !== "1";

        deps.setEnv(ENV.noScript, on ? "1" : undefined);
      },
    },
    {
      id: "tools.updateCheck",
      group: "Tools",
      label: "Update check",
      describe:
        "Check npm for a newer tsforge at startup (interactive only). On by default.",
      read: () => onOff(deps.getEnv(ENV.noUpdateCheck) !== "1"),
      activate: () => {
        const on = deps.getEnv(ENV.noUpdateCheck) !== "1";

        deps.setEnv(ENV.noUpdateCheck, on ? "1" : undefined);
      },
    },
  ];
}

// ── interactive driver: one owned-stdin menu loop ────────────────────────────

const ESC = String.fromCharCode(27);
const ENTER_ALT = `${ESC}[?1049h${ESC}[r`;
const EXIT_ALT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_HOME = `${ESC}[2J${ESC}[H`;
const RULE = "─".repeat(52);

interface IEditState {
  readonly setting: ISetting;
  readonly fieldIndex: number;
  readonly values: Record<string, string>;
}

interface IMenuState {
  cursor: number;
  edit: IEditState | null;
}

interface IKeyInfo {
  readonly name?: string;
  readonly ctrl?: boolean;
}

function currentField(edit: IEditState): IField {
  // fieldIndex is always in range for an active edit (advanced only past valid).
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

    // Every setting carries its own one-line description directly beneath it —
    // the config screen IS the docs; nothing is hidden behind a selection.
    rows.push(`${gutter} ${label}  ${paint("·", STYLE.dim, color)} ${value}`);
    rows.push(`    ${paint(s.describe, STYLE.dim, color)}`);
  });

  return [
    paint("tsforge config", STYLE.brand, color),
    `${paint("Settings", STYLE.bold, color)} · change anything here`,
    RULE,
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
    RULE,
    field.label,
    `  ${shown}${paint("▏", STYLE.brand, color)}`,
    ...(error === null ? [] : ["", paint(error, STYLE.yellow, color)]),
    "",
    paint("type   enter next   esc cancel", STYLE.dim, color),
  ].join("\n");
}

function renderConfig(
  settings: ISetting[],
  state: IMenuState,
  color: boolean
): string {
  return state.edit === null
    ? renderMenu(settings, state.cursor, color)
    : renderEdit(state.edit, color);
}

// ── the driver ───────────────────────────────────────────────────────────────

/**
 * Run the settings hub interactively. Owns stdin for its lifetime via a single
 * keypress loop (no raw-mode toggle, no `pause` — the REPL editor already owns
 * raw+flowing stdin and is suspended around this, so touching it would quit the
 * process). Resolves when the user presses Esc from the menu.
 */
export function runConfigMenu(deps: IConfigDeps): Promise<void> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return Promise.resolve();
  }

  const settings = buildSettings(deps);

  return new Promise((resolve) => {
    const state: IMenuState = { cursor: 0, edit: null };

    deps.suspend();
    emitKeypressEvents(stdin);

    const saved = stdin.rawListeners("keypress");

    stdin.removeAllListeners("keypress");

    const out = (s: string): void => {
      process.stdout.write(s);
    };

    const draw = (): void => {
      out(`${CLEAR_HOME}${renderConfig(settings, state, deps.color)}`);
    };

    const finish = (): void => {
      stdin.removeListener("keypress", onKey);

      try {
        out(`${SHOW_CURSOR}${EXIT_ALT}`);
      } catch {
        // stream closed — cleanup below still runs
      }

      for (const l of saved) {
        stdin.on("keypress", (...args: unknown[]) => {
          Reflect.apply(l, stdin, args);
        });
      }

      deps.resume();
      resolve();
    };

    const enterMenuSelection = (): void => {
      const setting = settings[state.cursor];

      if (setting === undefined) {
        return;
      }

      if (setting.fields !== undefined) {
        const values: Record<string, string> = {};

        for (const f of setting.fields) {
          values[f.key] = f.default ?? "";
        }

        state.edit = { setting, fieldIndex: 0, values };
        draw();

        return;
      }

      // choice/toggle: apply, then redraw the (possibly-async) new value.
      void Promise.resolve(setting.activate?.()).then(draw).catch(draw);
    };

    const advanceField = (): void => {
      const edit = state.edit;

      if (edit === null || fieldError(edit) !== null) {
        return; // blocked by validation
      }

      const fields = edit.setting.fields ?? [];

      if (edit.fieldIndex + 1 < fields.length) {
        state.edit = { ...edit, fieldIndex: edit.fieldIndex + 1 };
        draw();

        return;
      }

      // last field → apply, back to the menu.
      state.edit = null;
      void Promise.resolve(edit.setting.applyText?.(edit.values))
        .then(draw)
        .catch(draw);
    };

    const editKey = (
      str: string | undefined,
      name: string | undefined
    ): void => {
      const edit = state.edit;

      if (edit === null) {
        return;
      }

      const field = currentField(edit);

      if (name === "backspace") {
        edit.values[field.key] = (edit.values[field.key] ?? "").slice(0, -1);
        draw();
      } else if (str?.length === 1 && str >= " " && str <= "~") {
        edit.values[field.key] = `${edit.values[field.key] ?? ""}${str}`;
        draw();
      }
    };

    const onKey = (str: string | undefined, key: IKeyInfo): void => {
      try {
        if ((key.ctrl === true && key.name === "c") || key.name === "escape") {
          if (state.edit === null) {
            finish();
          } else {
            state.edit = null; // cancel edit → back to menu
            draw();
          }

          return;
        }

        if (state.edit !== null) {
          if (key.name === "return") {
            advanceField();
          } else {
            editKey(str, key.name);
          }

          return;
        }

        if (key.name === "up") {
          state.cursor = clampIndex(state.cursor - 1, settings.length);
          draw();
        } else if (key.name === "down") {
          state.cursor = clampIndex(state.cursor + 1, settings.length);
          draw();
        } else if (key.name === "return") {
          enterMenuSelection();
        }
      } catch {
        finish();
      }
    };

    stdin.on("keypress", onKey);
    out(`${ENTER_ALT}${HIDE_CURSOR}`);
    draw();
  });
}
