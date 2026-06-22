import { emitKeypressEvents } from "node:readline";
import { STYLE, paint } from "./style";
import { clampIndex } from "./command-menu";
import type {
  IWizardAction,
  IWizardOption,
  IWizardState,
  IWizardStep,
} from "./wizard.types";

const ESC = String.fromCharCode(27);
const ENTER_ALT = `${ESC}[?1049h${ESC}[r`;
const EXIT_ALT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_HOME = `${ESC}[2J${ESC}[H`;
const RULE = "─".repeat(52);

// ─────────────────────────── pure state model ───────────────────────────

/** Initial state: step 0, cursor on each step's recommendation, multi-checks
 *  seeded from defaults. */
export function initWizard(steps: readonly IWizardStep[]): IWizardState {
  const multi: Record<string, readonly number[]> = {};

  for (const s of steps) {
    if (s.kind === "multi") {
      // Drop any default-checked index that's out of range for the options.
      multi[s.key] = (s.defaultChecked ?? []).filter(
        (i) => i >= 0 && i < s.options.length
      );
    }
  }

  return {
    stepIndex: 0,
    cursor: steps[0]?.defaultIndex ?? 0,
    single: {},
    multi,
    status: "active",
  };
}

/** Where the cursor should sit when (re)entering a step: the recorded answer if
 *  any, else the step's recommended default. */
function cursorForStep(step: IWizardStep, state: IWizardState): number {
  if (step.kind === "single") {
    const chosen = state.single[step.key];

    if (chosen !== undefined) {
      const idx = step.options.findIndex((o) => o.value === chosen);

      if (idx >= 0) {
        return idx;
      }
    }
  }

  return step.defaultIndex ?? 0;
}

function toggleCheck(state: IWizardState, step: IWizardStep): IWizardState {
  // No options ⇒ nothing to toggle (clampIndex would otherwise yield index 0).
  if (step.options.length === 0) {
    return state;
  }

  const set = new Set(state.multi[step.key] ?? []);

  if (set.has(state.cursor)) {
    set.delete(state.cursor);
  } else {
    set.add(state.cursor);
  }

  return {
    ...state,
    multi: { ...state.multi, [step.key]: [...set].sort((a, b) => a - b) },
  };
}

function confirmStep(
  state: IWizardState,
  step: IWizardStep,
  steps: readonly IWizardStep[]
): IWizardState {
  const single =
    step.kind === "single"
      ? {
          ...state.single,
          [step.key]:
            step.options[clampIndex(state.cursor, step.options.length)]
              ?.value ?? "",
        }
      : state.single;
  const nextIndex = state.stepIndex + 1;
  const next = steps[nextIndex];

  return {
    ...state,
    single,
    stepIndex: nextIndex,
    cursor: next === undefined ? 0 : cursorForStep(next, { ...state, single }),
  };
}

function goBack(
  state: IWizardState,
  steps: readonly IWizardStep[]
): IWizardState {
  if (state.stepIndex === 0) {
    return { ...state, status: "cancel" };
  }

  const idx = state.stepIndex - 1;
  const step = steps[idx];

  return {
    ...state,
    stepIndex: idx,
    cursor: step === undefined ? 0 : cursorForStep(step, state),
  };
}

function reduceStep(
  state: IWizardState,
  action: IWizardAction,
  step: IWizardStep,
  steps: readonly IWizardStep[]
): IWizardState {
  switch (action) {
    case "up":
      return {
        ...state,
        cursor: clampIndex(state.cursor - 1, step.options.length),
      };
    case "down":
      return {
        ...state,
        cursor: clampIndex(state.cursor + 1, step.options.length),
      };
    case "toggle":
      return step.kind === "multi" ? toggleCheck(state, step) : state;
    case "confirm":
      return confirmStep(state, step, steps);
    case "back":
      return goBack(state, steps);
    default:
      return state;
  }
}

function reduceOverview(
  state: IWizardState,
  action: IWizardAction,
  steps: readonly IWizardStep[]
): IWizardState {
  if (action === "confirm") {
    return { ...state, status: "apply" };
  }

  if (action === "back") {
    const idx = steps.length - 1;
    const step = steps[idx];

    return {
      ...state,
      stepIndex: idx,
      cursor: step === undefined ? 0 : cursorForStep(step, state),
    };
  }

  return state;
}

/** The reducer: pure (state, action) → state. The whole wizard is testable through
 *  this without a terminal. */
export function reduceWizard(
  state: IWizardState,
  action: IWizardAction,
  steps: readonly IWizardStep[]
): IWizardState {
  if (state.status !== "active") {
    return state;
  }

  if (action === "cancel") {
    return { ...state, status: "cancel" };
  }

  if (state.stepIndex >= steps.length) {
    return reduceOverview(state, action, steps);
  }

  const step = steps[state.stepIndex];

  // A hole in the steps (e.g. an empty steps array) must still ADVANCE on confirm
  // so the flow can reach the overview rather than wedging on a missing step.
  if (step === undefined) {
    return action === "confirm"
      ? { ...state, stepIndex: state.stepIndex + 1 }
      : state;
  }

  return reduceStep(state, action, step, steps);
}

/** Fold a sequence of actions from the initial state — used by tests. */
export function driveWizard(
  steps: readonly IWizardStep[],
  actions: readonly IWizardAction[]
): IWizardState {
  return actions.reduce(
    (state, action) => reduceWizard(state, action, steps),
    initWizard(steps)
  );
}

/** The checked option VALUES for a multi-select step. */
export function checkedValues(
  state: IWizardState,
  step: IWizardStep
): string[] {
  return (state.multi[step.key] ?? []).flatMap((i) => {
    const o = step.options[i];

    return o === undefined ? [] : [o.value];
  });
}

// ──────────────────────────── pure rendering ────────────────────────────

function evidenceBlock(step: IWizardStep, color: boolean): string[] {
  if (step.evidence.length === 0) {
    return [];
  }

  return [
    paint("Evidence", STYLE.bold, color),
    ...step.evidence.map((e) => `  ${paint(e, STYLE.dim, color)}`),
    "",
  ];
}

function optionRow(
  opt: IWizardOption,
  active: boolean,
  marker: string,
  color: boolean
): string {
  const gutter = active ? paint("›", STYLE.brand, color) : " ";
  const label = paint(opt.label, active ? STYLE.brand : STYLE.bold, color);
  const rec =
    opt.recommended === true
      ? `  ${paint("recommended", STYLE.dim, color)}`
      : "";
  const note =
    opt.note === undefined ? "" : `  ${paint(opt.note, STYLE.dim, color)}`;

  return `${gutter} ${marker}${label}${rec}${note}`;
}

function singleChoiceRows(
  step: IWizardStep,
  cursor: number,
  color: boolean
): string[] {
  return step.options.map((opt, i) => optionRow(opt, i === cursor, "", color));
}

function multiChoiceRows(
  step: IWizardStep,
  cursor: number,
  checkedIdx: readonly number[],
  color: boolean
): string[] {
  const checked = new Set(checkedIdx);

  return step.options.map((opt, i) =>
    optionRow(opt, i === cursor, `${checked.has(i) ? "◉" : "◯"} `, color)
  );
}

function hints(step: IWizardStep, color: boolean): string {
  const parts =
    step.kind === "multi"
      ? ["space toggle", "enter continue", "b back", "q cancel"]
      : ["↑/↓ move", "enter select", "b back", "q cancel"];

  return paint(parts.join("   "), STYLE.dim, color);
}

function renderStep(
  step: IWizardStep,
  state: IWizardState,
  color: boolean,
  total: number
): string {
  const rows =
    step.kind === "multi"
      ? multiChoiceRows(step, state.cursor, state.multi[step.key] ?? [], color)
      : singleChoiceRows(step, state.cursor, color);

  const active = step.options[clampIndex(state.cursor, step.options.length)];
  const outcome =
    step.kind === "single" && active?.outcome !== undefined
      ? ["", paint("Outcome", STYLE.bold, color), `  ${active.outcome}`]
      : [];

  return [
    paint("tsforge setup", STYLE.brand, color),
    `${paint(`Step ${state.stepIndex + 1} of ${total}`, STYLE.bold, color)} · ${step.title}`,
    RULE,
    step.explanation,
    "",
    ...evidenceBlock(step, color),
    paint("Choices", STYLE.bold, color),
    ...rows,
    ...outcome,
    "",
    hints(step, color),
  ].join("\n");
}

/** One readable summary line per step for the overview ("Title: chosen"). */
function overviewLines(
  steps: readonly IWizardStep[],
  state: IWizardState,
  color: boolean
): string[] {
  return steps.map((step) => {
    const checked = checkedValues(state, step).join(", ");
    const value =
      step.kind === "single"
        ? (step.options.find((o) => o.value === state.single[step.key])
            ?.label ?? "(default)")
        : checked.length > 0
          ? checked
          : "(none)";

    return `  ${paint(step.title, STYLE.bold, color)}: ${value}`;
  });
}

function renderOverview(
  steps: readonly IWizardStep[],
  state: IWizardState,
  color: boolean,
  extra: string
): string {
  return [
    paint("tsforge setup", STYLE.brand, color),
    `${paint("Review", STYLE.bold, color)} · nothing is written until you Apply`,
    RULE,
    ...overviewLines(steps, state, color),
    ...(extra.length > 0 ? ["", extra] : []),
    "",
    paint("enter apply   b back   q cancel", STYLE.dim, color),
  ].join("\n");
}

/** Render the current frame (a step, or the final overview). `extra` is appended
 *  to the overview (the exact config preview + evidence path). Pure. */
export function renderFrame(
  state: IWizardState,
  steps: readonly IWizardStep[],
  color: boolean,
  extra = ""
): string {
  if (state.stepIndex >= steps.length) {
    return renderOverview(steps, state, color, extra);
  }

  const step = steps[state.stepIndex];

  return step === undefined ? "" : renderStep(step, state, color, steps.length);
}

// ──────────────────────────── interactive driver ────────────────────────────

interface IKeyInfo {
  readonly name?: string;
  readonly ctrl?: boolean;
}

/** Map a raw keypress to a wizard action, or null to ignore. Digits jump the
 *  cursor and are handled by the driver (not here). */
function actionFor(
  str: string | undefined,
  key: IKeyInfo
): IWizardAction | null {
  if ((key.ctrl === true && key.name === "c") || key.name === "escape") {
    return "cancel";
  }

  switch (key.name) {
    case "up":
      return "up";
    case "down":
      return "down";
    case "space":
      return "toggle";
    case "return":
    case "enter":
      return "confirm";
    default:
      break;
  }

  if (str === "b") {
    return "back";
  }

  if (str === "q") {
    return "cancel";
  }

  if (str === " ") {
    return "toggle";
  }

  return null;
}

/**
 * Run the wizard interactively on the alternate screen, returning the final state
 * (status "apply" or "cancel"). Owns keypress for its lifetime (stash + restore the
 * existing listeners, like pickCommand), never toggles raw mode. Off a TTY it
 * resolves immediately to a cancelled state — the CLI handles non-TTY separately.
 * `extra(state)` supplies the live config preview for the overview.
 */
export function runWizard(
  steps: readonly IWizardStep[],
  color: boolean,
  extra: (state: IWizardState) => string = () => "",
  out: (s: string) => void = (s) => process.stdout.write(s)
): Promise<IWizardState> {
  const stdin = process.stdin;
  const cancelled: IWizardState = { ...initWizard(steps), status: "cancel" };

  if (!stdin.isTTY) {
    return Promise.resolve(cancelled);
  }

  return new Promise((resolve) => {
    let state = initWizard(steps);

    emitKeypressEvents(stdin);

    const saved = stdin.rawListeners("keypress");

    stdin.removeAllListeners("keypress");

    // Raw mode is what turns an arrow key into a decoded `up`/`down` keypress
    // instead of a raw `^[[A` the terminal echoes. When there were already
    // keypress listeners (the REPL's readline, for `/setup`), a consumer owns raw
    // mode — leave it. With none (standalone `tsforge setup`, cooked stdin) the
    // wizard must enable it itself and restore on exit, or arrows do nothing.
    const ownsRawMode =
      stdin.isTTY &&
      typeof stdin.setRawMode === "function" &&
      saved.length === 0;

    if (ownsRawMode) {
      stdin.setRawMode(true);
      stdin.resume();
    }

    const draw = (): void => {
      out(`${CLEAR_HOME}${renderFrame(state, steps, color, extra(state))}`);
    };

    const finish = (): void => {
      stdin.removeListener("keypress", onKey);

      // Undo the raw mode WE enabled (never touch it when a consumer owned it).
      if (ownsRawMode) {
        stdin.setRawMode(false);
        stdin.pause();
      }

      // The terminal write is best-effort and must NEVER throw out of finish: a
      // throwing `out` (e.g. EPIPE on a closed stdout) would otherwise skip the
      // listener restore + resolve below AND re-enter finish via onKey's catch,
      // wedging the terminal (dead keypress, hung Promise) on exit. The terminal
      // is already gone in that case, so there's nothing to restore on it.
      try {
        out(`${SHOW_CURSOR}${EXIT_ALT}`);
      } catch {
        // swallow — the stream is closed; cleanup below still runs
      }

      // Restore the saved keypress listeners. They come from `rawListeners` typed
      // as `Function[]`, which isn't assignable to the listener signature, so we
      // forward through a thin wrapper (House rules forbid `as`). This mirrors the
      // reviewed `pickCommand` pattern; within a run `onKey` is detached first, so
      // there's no duplication.
      for (const l of saved) {
        stdin.on("keypress", (...args: unknown[]) => {
          Reflect.apply(l, stdin, args);
        });
      }

      resolve(state);
    };

    const onKey = (str: string | undefined, key: IKeyInfo): void => {
      try {
        const action = actionFor(str, key);

        if (action === null) {
          return;
        }

        state = reduceWizard(state, action, steps);

        if (state.status !== "active") {
          finish();
        } else {
          draw();
        }
      } catch {
        state = cancelled;
        finish();
      }
    };

    stdin.on("keypress", onKey);
    out(`${ENTER_ALT}${HIDE_CURSOR}`);
    draw();
  });
}
