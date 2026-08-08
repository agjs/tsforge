import { emitKeypressEvents } from "node:readline";
import { STYLE, paint } from "./style";
import { clampIndex } from "./command-menu";
import type {
  IWizardAction,
  IWizardOption,
  IWizardState,
  IWizardStep,
  IWizardView,
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
  const text: Record<string, string> = {};

  for (const s of steps) {
    if (s.kind === "multi") {
      // Drop any default-checked index that's out of range for the options.
      multi[s.key] = (s.defaultChecked ?? []).filter(
        (i) => i >= 0 && i < s.options.length
      );
    } else if (s.kind === "text") {
      text[s.key] = s.default ?? "";
    }
  }

  const base: IWizardState = {
    stepIndex: 0,
    cursor: 0,
    single: {},
    multi,
    text,
    status: "active",
  };
  // Start on the first VISIBLE step — an initially-hidden step 0 must be skipped
  // so the wizard never opens on a question it means to hide.
  const startIndex = nextVisibleIndex(steps, 0, base);

  return {
    ...base,
    stepIndex: startIndex,
    cursor: steps[startIndex]?.defaultIndex ?? 0,
  };
}

/** Options that shape reduction: review screen on/off (default on). */
export interface IWizardOpts {
  readonly review?: boolean;
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

/** A step with no predicate is always shown; otherwise its predicate decides. */
function isVisible(step: IWizardStep, state: IWizardState): boolean {
  return step.visibleWhen === undefined || step.visibleWhen(state);
}

/** First index >= `from` whose step is visible; `steps.length` if none remain. */
function nextVisibleIndex(
  steps: readonly IWizardStep[],
  from: number,
  state: IWizardState
): number {
  let i = Math.max(0, from);

  while (i < steps.length) {
    const s = steps[i];

    if (s !== undefined && isVisible(s, state)) {
      return i;
    }

    i += 1;
  }

  return steps.length;
}

/** Last index <= `from` whose step is visible; -1 if none remain before it. */
function prevVisibleIndex(
  steps: readonly IWizardStep[],
  from: number,
  state: IWizardState
): number {
  let i = Math.min(from, steps.length - 1);

  while (i >= 0) {
    const s = steps[i];

    if (s !== undefined && isVisible(s, state)) {
      return i;
    }

    i -= 1;
  }

  return -1;
}

/** Overlay each unanswered single step's DEFAULT value onto the state. The "Step X
 *  of N" counter uses this so a default-ON gate's dependent is counted from the
 *  start — without it, a dependent reads as hidden until its gate is confirmed and
 *  the total would jump (e.g. "1 of 14" → "of 15" after confirming the cache). */
function withDefaultAnswers(
  steps: readonly IWizardStep[],
  state: IWizardState
): IWizardState {
  const single: Record<string, string> = { ...state.single };

  for (const s of steps) {
    if (s.kind === "single" && single[s.key] === undefined) {
      const v = s.options[s.defaultIndex ?? 0]?.value;

      if (v !== undefined) {
        single[s.key] = v;
      }
    }
  }

  return { ...state, single };
}

/** Count of visible steps under the current answers + unanswered defaults (the
 *  denominator for "Step X of N"). */
function visibleTotal(
  steps: readonly IWizardStep[],
  state: IWizardState
): number {
  const eff = withDefaultAnswers(steps, state);

  return steps.filter((s) => isVisible(s, eff)).length;
}

/** 1-based position of `stepIndex` among the visible steps (for "Step X of N"). */
function visiblePosition(
  steps: readonly IWizardStep[],
  state: IWizardState,
  stepIndex: number
): number {
  const eff = withDefaultAnswers(steps, state);
  let n = 0;

  for (let i = 0; i <= stepIndex && i < steps.length; i += 1) {
    const s = steps[i];

    if (s !== undefined && isVisible(s, eff)) {
      n += 1;
    }
  }

  return n;
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

/** The current value of a text step. */
export function textValue(state: IWizardState, step: IWizardStep): string {
  return state.text[step.key] ?? "";
}

function typeChar(
  state: IWizardState,
  step: IWizardStep,
  ch: string
): IWizardState {
  if (step.kind !== "text") {
    return state;
  }

  return {
    ...state,
    text: { ...state.text, [step.key]: `${state.text[step.key] ?? ""}${ch}` },
  };
}

function eraseChar(state: IWizardState, step: IWizardStep): IWizardState {
  if (step.kind !== "text") {
    return state;
  }

  return {
    ...state,
    text: {
      ...state.text,
      [step.key]: (state.text[step.key] ?? "").slice(0, -1),
    },
  };
}

/** True when a text step has a validator that rejects its current value. */
function textInvalid(state: IWizardState, step: IWizardStep): boolean {
  return (
    step.kind === "text" &&
    step.validate !== undefined &&
    step.validate(state.text[step.key] ?? "") !== null
  );
}

function confirmStep(
  state: IWizardState,
  step: IWizardStep,
  steps: readonly IWizardStep[],
  opts: IWizardOpts
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
  // Visibility of later steps can depend on the answer just recorded (e.g. turning
  // the cache off hides "cache provider"), so evaluate against the updated state.
  const advanced = { ...state, single };
  const nextIndex = nextVisibleIndex(steps, state.stepIndex + 1, advanced);

  // Review off + no visible step left → apply immediately, skipping the overview.
  if (opts.review === false && nextIndex >= steps.length) {
    return { ...state, single, status: "apply" };
  }

  const next = steps[nextIndex];

  return {
    ...state,
    single,
    stepIndex: nextIndex,
    cursor: next === undefined ? 0 : cursorForStep(next, advanced),
  };
}

function goBack(
  state: IWizardState,
  steps: readonly IWizardStep[]
): IWizardState {
  // Step back to the previous VISIBLE step; if none precede this one, cancel
  // (mirrors the old stepIndex===0 behavior once hidden steps are skipped).
  const idx = prevVisibleIndex(steps, state.stepIndex - 1, state);

  if (idx < 0) {
    return { ...state, status: "cancel" };
  }

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
  steps: readonly IWizardStep[],
  opts: IWizardOpts
): IWizardState {
  if (typeof action === "object") {
    return typeChar(state, step, action.char);
  }

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
    case "erase":
      return eraseChar(state, step);
    case "confirm":
      // A text step with an unmet validator blocks advance.
      return textInvalid(state, step)
        ? state
        : confirmStep(state, step, steps, opts);
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
    const idx = prevVisibleIndex(steps, steps.length - 1, state);

    if (idx < 0) {
      // No visible step to return to (every step is hidden) — treat back as
      // cancel, matching goBack, rather than dead-ending on the review screen.
      return { ...state, status: "cancel" };
    }

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
  steps: readonly IWizardStep[],
  opts: IWizardOpts = {}
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

  return reduceStep(state, action, step, steps, opts);
}

/** Fold a sequence of actions from the initial state — used by tests. */
export function driveWizard(
  steps: readonly IWizardStep[],
  actions: readonly IWizardAction[],
  opts: IWizardOpts = {}
): IWizardState {
  return actions.reduce(
    (state, action) => reduceWizard(state, action, steps, opts),
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
  const gutter = active ? paint("›", STYLE.cyan, color) : " ";
  const label = paint(opt.label, active ? STYLE.cyan : STYLE.bold, color);
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
    step.kind === "text"
      ? ["type to edit", "← back", "enter continue", "esc cancel"]
      : step.kind === "multi"
        ? ["space toggle", "enter continue", "b back", "q cancel"]
        : ["↑/↓ move", "enter select", "b back", "q cancel"];

  return paint(parts.join("   "), STYLE.dim, color);
}

/** The editable field for a text step: value (or placeholder) + caret, masked for
 *  secrets, with an inline validation error when the validator rejects it. */
function textFieldRows(
  step: IWizardStep,
  state: IWizardState,
  color: boolean
): string[] {
  const raw = textValue(state, step);
  const shown =
    raw.length === 0
      ? paint(step.placeholder ?? "", STYLE.dim, color)
      : step.mask === true
        ? "•".repeat(raw.length)
        : raw;
  const field = `${shown}${paint("▏", STYLE.cyan, color)}`;
  const error = step.validate === undefined ? null : step.validate(raw);
  const errorLine =
    error === null ? [] : ["", paint(error, STYLE.yellow, color)];

  return [paint("Value", STYLE.bold, color), `  ${field}`, ...errorLine];
}

function stepBody(
  step: IWizardStep,
  state: IWizardState,
  color: boolean
): string[] {
  if (step.kind === "text") {
    return textFieldRows(step, state, color);
  }

  const active = step.options[clampIndex(state.cursor, step.options.length)];
  const outcome =
    step.kind === "single" && active?.outcome !== undefined
      ? ["", paint("Outcome", STYLE.bold, color), `  ${active.outcome}`]
      : [];
  const rows =
    step.kind === "multi"
      ? multiChoiceRows(step, state.cursor, state.multi[step.key] ?? [], color)
      : singleChoiceRows(step, state.cursor, color);

  return [paint("Choices", STYLE.bold, color), ...rows, ...outcome];
}

function renderStep(
  step: IWizardStep,
  state: IWizardState,
  color: boolean,
  position: number,
  total: number,
  title: string
): string {
  return [
    paint(title, STYLE.brand, color),
    `${paint(`Step ${position} of ${total}`, STYLE.bold, color)} · ${step.title}`,
    RULE,
    step.explanation,
    "",
    ...evidenceBlock(step, color),
    ...stepBody(step, state, color),
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
  // Hidden steps have no answer that matters — omit them from the review.
  return steps
    .filter((step) => isVisible(step, state))
    .map((step) => {
      const value = overviewValue(step, state);

      return `  ${paint(step.title, STYLE.bold, color)}: ${value}`;
    });
}

/** The one-line answer shown for a step on the review screen. */
function overviewValue(step: IWizardStep, state: IWizardState): string {
  if (step.kind === "text") {
    const raw = textValue(state, step);

    return raw.length === 0 ? "(empty)" : step.mask === true ? "••••" : raw;
  }

  if (step.kind === "single") {
    return (
      step.options.find((o) => o.value === state.single[step.key])?.label ??
      "(default)"
    );
  }

  const checked = checkedValues(state, step).join(", ");

  return checked.length > 0 ? checked : "(none)";
}

function renderOverview(
  steps: readonly IWizardStep[],
  state: IWizardState,
  color: boolean,
  extra: string,
  title: string
): string {
  return [
    paint(title, STYLE.brand, color),
    `${paint("Review", STYLE.bold, color)} · nothing is written until you Apply`,
    RULE,
    ...overviewLines(steps, state, color),
    ...(extra.length > 0 ? ["", extra] : []),
    "",
    paint("enter apply   b back   q cancel", STYLE.dim, color),
  ].join("\n");
}

/** Render the current frame (a step, or the final overview). `extra` is appended
 *  to the overview (the exact config preview + evidence path). `title` is the
 *  header shown at the top of every frame. Pure. */
export function renderFrame(
  state: IWizardState,
  steps: readonly IWizardStep[],
  color: boolean,
  extra = "",
  title = "tsforge setup"
): string {
  if (state.stepIndex >= steps.length) {
    return renderOverview(steps, state, color, extra, title);
  }

  const step = steps[state.stepIndex];

  return step === undefined
    ? ""
    : renderStep(
        step,
        state,
        color,
        visiblePosition(steps, state, state.stepIndex),
        visibleTotal(steps, state),
        title
      );
}

// ──────────────────────────── interactive driver ────────────────────────────

interface IKeyInfo {
  readonly name?: string;
  readonly ctrl?: boolean;
}

/** Map a raw keypress to a wizard action, or null to ignore. Digits jump the
 *  cursor and are handled by the driver (not here). Exported so the key→action
 *  decode is unit-testable without a PTY (the raw-mode plumbing around it is
 *  not — see node-pty/Bun limits). */
export function actionFor(
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
    case "backspace":
      return "erase";
    case "return":
    case "enter":
      return "confirm";
    default:
      break;
  }

  // Any single printable ASCII character (0x20–0x7e) is text input (a text step
  // consumes it; other kinds ignore it in the reducer). The upper bound excludes
  // DEL (0x7f), which is backspace and must decode as "erase" above. The driver
  // maps `b`/`q` to back/cancel for non-text steps, so those still work off a field.
  if (str?.length === 1 && str >= " " && str <= "~") {
    return { char: str };
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
export interface IRunWizardOpts {
  /** Header shown atop every frame (default "tsforge setup"). */
  readonly title?: string;
  /** Show the Review/Apply overview after the last step (default true). */
  readonly review?: boolean;
  /** Whether the wizard manages raw mode + stdin flow (default true). Pass FALSE
   *  when launched from the REPL, where the editor/readline already owns stdin —
   *  otherwise the wizard pauses stdin on exit and the process quits. */
  readonly manageInput?: boolean;
  /** Extra text appended to the overview (e.g. a config preview). */
  readonly extra?: (state: IWizardState) => string;
  /** Output sink (default process.stdout.write). */
  readonly out?: (s: string) => void;
  /** When set, paint into the host chrome (main pane / status overlay) instead of
   *  opening a nested alt-screen. Required under the pane console so setup/scaffold
   *  do not fight PaneScreen. */
  readonly view?: IWizardView;
}

/**
 * Whether runWizard should toggle raw mode + pause stdin on exit itself. Only when
 * it TRULY owns stdin: a standalone `tsforge setup` on a cooked TTY with no
 * pre-existing keypress listeners. REPL callers pass `manageInput: false`, so this
 * returns false and the wizard never pauses stdin (which would empty the event loop
 * and quit the process). Pure so the ownership rule is unit-testable.
 */
export function wizardOwnsRawMode(
  manageInput: boolean,
  isTTY: boolean,
  hasSetRawMode: boolean,
  savedKeypressCount: number
): boolean {
  return manageInput && isTTY && hasSetRawMode && savedKeypressCount === 0;
}

export function runWizard(
  steps: readonly IWizardStep[],
  color: boolean,
  opts: IRunWizardOpts = {}
): Promise<IWizardState> {
  const stdin = process.stdin;
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const extra = opts.extra ?? ((): string => "");
  const title = opts.title ?? "tsforge setup";
  const cancelled: IWizardState = { ...initWizard(steps), status: "cancel" };

  if (!stdin.isTTY) {
    return Promise.resolve(cancelled);
  }

  return new Promise((resolve) => {
    let state = initWizard(steps);
    const view = opts.view;

    emitKeypressEvents(stdin);

    const saved = stdin.rawListeners("keypress");

    stdin.removeAllListeners("keypress");

    // Raw mode turns an arrow key into a decoded `up`/`down` keypress instead of a
    // raw `^[[A`. The wizard should only manage (toggle + pause on exit) raw mode
    // when it truly owns stdin — a STANDALONE `tsforge setup` on cooked stdin.
    // When launched from the REPL a consumer already owns stdin: readline (which
    // leaves keypress listeners) OR the multiline editor (which owns stdin via a
    // `data` listener and leaves NO keypress listeners). The listener count can't
    // tell the editor apart from standalone, so REPL callers pass
    // `manageInput: false` — otherwise the wizard's `stdin.pause()` on exit empties
    // the event loop and the whole process quits when you cancel/finish a wizard.
    const ownsRawMode = wizardOwnsRawMode(
      opts.manageInput ?? true,
      stdin.isTTY,
      typeof stdin.setRawMode === "function",
      saved.length
    );

    if (ownsRawMode) {
      stdin.setRawMode(true);
      stdin.resume();
    }

    const draw = (): void => {
      const frame = renderFrame(state, steps, color, extra(state), title);

      if (view !== undefined) {
        view.render(frame.split("\n"));
      } else {
        out(`${CLEAR_HOME}${frame}`);
      }
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
        if (view !== undefined) {
          view.close();
        } else {
          out(`${SHOW_CURSOR}${EXIT_ALT}`);
        }
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
        const step = steps[state.stepIndex];
        const isText = step?.kind === "text";
        let action = actionFor(str, key);

        if (isText) {
          // On a text field EVERY printable key is literal input — including
          // space (which `actionFor` decodes as "toggle" by name), `b`, and `q`.
          // Back is the ← arrow (unused while editing); Esc still cancels.
          if (str?.length === 1 && str >= " " && str <= "~") {
            action = { char: str };
          } else if (key.name === "left") {
            action = "back";
          }
        } else if (str === "b") {
          action = "back";
        } else if (str === "q") {
          action = "cancel";
        }

        if (action === null) {
          return;
        }

        state = reduceWizard(state, action, steps, { review: opts.review });

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

    if (view === undefined) {
      out(`${ENTER_ALT}${HIDE_CURSOR}`);
    }

    draw();
  });
}
