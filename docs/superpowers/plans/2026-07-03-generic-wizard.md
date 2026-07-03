# Generic Wizard Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the existing `render/wizard.ts` into a reusable wizard primitive (parameterized title, a `text` step kind, an optional review screen) and refactor `/setup` onto it, so `/config` and "add a model" can be built as wizard flows later.

**Architecture:** Keep the existing pure state model (`initWizard`/`reduceWizard`) and the interactive driver (`runWizard`, alt-screen + raw-mode + listener restore). Extend the type surface and reducer with a `text` step kind and character input, thread `title`/`review` options through render and driver, and make `/setup` a caller that passes its own title. No behavior change for setup.

**Tech Stack:** TypeScript (strict), Bun test, Node `readline` keypress, Python `pty` for the real-terminal e2e.

## Global Constraints

- House rules (verbatim): no `as` casts; no `eslint-disable`; cyclomatic complexity ≤ 20; reuse shared walkers; explicit boolean conditions; no non-null `!`; `===`; `I`-prefixed interfaces.
- `bun run validate` (check:bun + typecheck + lint + format:check + test + e2e:pty) must pass.
- Do not touch the `runWizard` raw-mode ownership / listener stash-restore / EPIPE-guarded `finish` logic except to pass new options through.
- Behavior-preserving for `/setup`: existing setup + wizard tests stay green.

---

### Task 1: `text` step kind + character input in the pure model

**Files:**
- Modify: `packages/core/src/render/wizard.types.ts`
- Modify: `packages/core/src/render/wizard.ts` (state model region, lines ~19–229)
- Test: `packages/core/tests/wizard.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `IWizardStep.kind` now includes `"text"`; `IWizardStep` gains `placeholder?`, `default?`, `mask?`, `validate?`; `IWizardState` gains `text: Readonly<Record<string,string>>`; `IWizardAction` gains `"erase"` and the object form `{ readonly char: string }`; new helper `textValue(state, step): string`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/tests/wizard.test.ts`:

```ts
import { driveWizard, textValue } from "../src/render/wizard";
import type { IWizardStep } from "../src/render/wizard.types";

const textStep: IWizardStep = {
  key: "baseUrl",
  kind: "text",
  title: "Base URL",
  explanation: "The API root",
  evidence: [],
  options: [],
  default: "http://localhost:8000/v1",
};

test("text step: default is used when nothing typed, confirm advances", () => {
  const s = driveWizard([textStep], ["confirm"]);
  expect(s.text.baseUrl).toBe("http://localhost:8000/v1");
  expect(s.status).toBe("apply"); // single step, review defaults on → overview; confirm again applies
});

test("text step: typed characters replace the default; erase backspaces", () => {
  const s = driveWizard(
    [textStep],
    [{ char: "a" }, { char: "b" }, { char: "c" }, "erase"]
  );
  expect(textValue(s, textStep)).toBe("ab");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/tests/wizard.test.ts -t "text step"`
Expected: FAIL — `textValue` is not exported / `kind: "text"` not assignable / `{char}` not an `IWizardAction`.

- [ ] **Step 3: Extend the types**

In `packages/core/src/render/wizard.types.ts`, replace the `IWizardStep` and `IWizardAction` and `IWizardState` definitions:

```ts
export interface IWizardStep {
  readonly key: string;
  readonly kind: "single" | "multi" | "text";
  readonly title: string;
  readonly explanation: string;
  readonly evidence: readonly string[];
  readonly options: readonly IWizardOption[];
  /** Single-select: the preselected option index (the recommendation). */
  readonly defaultIndex?: number;
  /** Multi-select: option indices checked on entry. */
  readonly defaultChecked?: readonly number[];
  /** Text: prefilled value shown on entry (editable). */
  readonly default?: string;
  /** Text: hint shown when the field is empty. */
  readonly placeholder?: string;
  /** Text: render the value as bullets (secrets, e.g. an API key). */
  readonly mask?: boolean;
  /** Text: return an error message to block confirm, or null when valid. */
  readonly validate?: (value: string) => string | null;
}

/** Normalized input action. `{ char }` is one typed character (text steps). */
export type IWizardAction =
  | "up"
  | "down"
  | "toggle"
  | "confirm"
  | "back"
  | "cancel"
  | "erase"
  | { readonly char: string };

export interface IWizardState {
  readonly stepIndex: number;
  readonly cursor: number;
  readonly single: Readonly<Record<string, string>>;
  readonly multi: Readonly<Record<string, readonly number[]>>;
  readonly text: Readonly<Record<string, string>>;
  readonly status: "active" | "apply" | "cancel";
}
```

- [ ] **Step 4: Seed text on init/entry and handle char/erase/confirm in the reducer**

In `packages/core/src/render/wizard.ts`:

Update `initWizard` to seed text defaults and include `text` in the returned state:

```ts
export function initWizard(steps: readonly IWizardStep[]): IWizardState {
  const multi: Record<string, readonly number[]> = {};
  const text: Record<string, string> = {};

  for (const s of steps) {
    if (s.kind === "multi") {
      multi[s.key] = (s.defaultChecked ?? []).filter(
        (i) => i >= 0 && i < s.options.length
      );
    } else if (s.kind === "text") {
      text[s.key] = s.default ?? "";
    }
  }

  return {
    stepIndex: 0,
    cursor: steps[0]?.defaultIndex ?? 0,
    single: {},
    multi,
    text,
    status: "active",
  };
}
```

Add the text helper + edit reducers (place near `toggleCheck`):

```ts
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

  const current = state.text[step.key] ?? "";

  return {
    ...state,
    text: { ...state.text, [step.key]: current.slice(0, -1) },
  };
}
```

Update `reduceStep` to route the new actions and block confirm on invalid text:

```ts
function reduceStep(
  state: IWizardState,
  action: IWizardAction,
  step: IWizardStep,
  steps: readonly IWizardStep[]
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
      return step.kind === "text" &&
        step.validate !== undefined &&
        step.validate(state.text[step.key] ?? "") !== null
        ? state
        : confirmStep(state, step, steps);
    case "back":
      return goBack(state, steps);
    default:
      return state;
  }
}
```

Update the `reduceWizard` top-level `cancel` guard (it currently checks `action === "cancel"` — that still works since object actions are never "cancel"). No change needed there beyond the object never matching the string cases.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core/tests/wizard.test.ts -t "text step"`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/render/wizard.types.ts packages/core/src/render/wizard.ts packages/core/tests/wizard.test.ts
git commit -m "feat(wizard): text step kind + character input in the pure model"
```

---

### Task 2: Parameterized title + optional review screen

**Files:**
- Modify: `packages/core/src/render/wizard.ts` (`reduceOverview`/`reduceWizard`, `renderStep`/`renderOverview`/`renderFrame`)
- Test: `packages/core/tests/wizard.test.ts`

**Interfaces:**
- Consumes: Task 1 state shape.
- Produces: `reduceWizard(state, action, steps, opts?: IWizardOpts)` and `driveWizard(steps, actions, opts?)` and `renderFrame(state, steps, color, extra?, title?)`; `IWizardOpts = { readonly review?: boolean }`. When `review === false`, confirming the last step yields `status:"apply"` directly (no overview).

- [ ] **Step 1: Write the failing test**

```ts
test("review:false applies on the last step's confirm (no overview)", () => {
  const s = driveWizard([textStep], ["confirm"], { review: false });
  expect(s.status).toBe("apply");
  expect(s.text.baseUrl).toBe("http://localhost:8000/v1");
});

test("renderFrame uses the supplied title", () => {
  const frame = renderFrame(initWizard([textStep]), [textStep], false, "", "config");
  expect(frame).toContain("config");
  expect(frame).not.toContain("tsforge setup");
});
```

(Add `renderFrame`, `initWizard` to the existing import from `../src/render/wizard`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/tests/wizard.test.ts -t "review:false"`
Expected: FAIL — `driveWizard` takes 2 args / `renderFrame` has no title param / status becomes "active" (overview), not "apply".

- [ ] **Step 3: Thread `IWizardOpts` through the reducer**

In `packages/core/src/render/wizard.ts` add the type and update `confirmStep` to short-circuit to apply when review is off and this is the last step:

```ts
export interface IWizardOpts {
  readonly review?: boolean;
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
  const nextIndex = state.stepIndex + 1;

  // review off + last step → apply immediately, skipping the overview.
  if (opts.review === false && nextIndex >= steps.length) {
    return { ...state, single, status: "apply" };
  }

  const next = steps[nextIndex];

  return {
    ...state,
    single,
    stepIndex: nextIndex,
    cursor: next === undefined ? 0 : cursorForStep(next, { ...state, single }),
  };
}
```

Thread `opts` through `reduceStep` and `reduceWizard` (default `{}`), and `driveWizard`:

```ts
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
  if (step === undefined) {
    return action === "confirm"
      ? { ...state, stepIndex: state.stepIndex + 1 }
      : state;
  }
  return reduceStep(state, action, step, steps, opts);
}

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
```

Update `reduceStep`'s signature to accept + forward `opts` to `confirmStep` (only the confirm case changes: `return … confirmStep(state, step, steps, opts)`).

- [ ] **Step 4: Parameterize the title in render**

Replace the hardcoded `"tsforge setup"` in `renderStep` and `renderOverview` with a `title` param, and thread it through `renderFrame` (default `"tsforge setup"` so existing setup output is unchanged):

```ts
function renderStep(
  step: IWizardStep,
  state: IWizardState,
  color: boolean,
  total: number,
  title: string
): string {
  // …unchanged body, except the first line:
  //   paint(title, STYLE.brand, color),
}

function renderOverview(
  steps: readonly IWizardStep[],
  state: IWizardState,
  color: boolean,
  extra: string,
  title: string
): string {
  // …unchanged, first line: paint(title, STYLE.brand, color),
}

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
    : renderStep(step, state, color, steps.length, title);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test packages/core/tests/wizard.test.ts`
Expected: PASS (new + existing wizard tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/render/wizard.ts packages/core/tests/wizard.test.ts
git commit -m "feat(wizard): parameterized title + optional review screen"
```

---

### Task 3: Render text steps (value, caret, mask, validation error)

**Files:**
- Modify: `packages/core/src/render/wizard.ts` (`renderStep`, `hints`)
- Test: `packages/core/tests/wizard.test.ts`

**Interfaces:**
- Consumes: Task 1 (`textValue`, `text` state), Task 2 (`renderFrame` title).
- Produces: a text step renders its current value + a caret `▏`; masked steps render bullets `•`; an inline validation error line appears under the field when `validate` returns non-null.

- [ ] **Step 1: Write the failing test**

```ts
const keyStep: IWizardStep = {
  key: "apiKey",
  kind: "text",
  title: "API key",
  explanation: "Secret",
  evidence: [],
  options: [],
  mask: true,
  validate: (v) => (v.length === 0 ? "required" : null),
};

test("text render: masks the value and shows a validation error when empty", () => {
  const typed = driveWizard([keyStep], [{ char: "s" }, { char: "k" }]);
  const frame = renderFrame(typed, [keyStep], false, "", "config");
  expect(frame).toContain("••"); // masked, not "sk"
  expect(frame).not.toContain("sk");

  const empty = initWizard([keyStep]);
  expect(renderFrame(empty, [keyStep], false, "", "config")).toContain("required");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/tests/wizard.test.ts -t "text render"`
Expected: FAIL — text steps currently render option rows (empty) with no value/mask/error.

- [ ] **Step 3: Add a text-field renderer**

In `packages/core/src/render/wizard.ts`, add a text branch to `renderStep`. Insert before the `rows =` computation and branch on `step.kind === "text"`:

```ts
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
  const field = `${shown}${paint("▏", STYLE.brand, color)}`;
  const error =
    step.validate === undefined ? null : step.validate(raw);
  const errorLine =
    error === null ? [] : ["", paint(error, STYLE.yellow, color)];

  return [paint("Value", STYLE.bold, color), `  ${field}`, ...errorLine];
}
```

In `renderStep`, produce the body per kind:

```ts
  const body =
    step.kind === "text"
      ? textFieldRows(step, state, color)
      : [
          paint("Choices", STYLE.bold, color),
          ...(step.kind === "multi"
            ? multiChoiceRows(step, state.cursor, state.multi[step.key] ?? [], color)
            : singleChoiceRows(step, state.cursor, color)),
          ...outcome,
        ];
```

Then assemble with `...body` where `...rows, ...outcome` were. Guard `outcome` computation so it only runs for single (leave as-is; it already checks `step.kind === "single"`).

Update `hints` for the text kind:

```ts
function hints(step: IWizardStep, color: boolean): string {
  const parts =
    step.kind === "text"
      ? ["type to edit", "enter continue", "b back", "q cancel"]
      : step.kind === "multi"
        ? ["space toggle", "enter continue", "b back", "q cancel"]
        : ["↑/↓ move", "enter select", "b back", "q cancel"];
  return paint(parts.join("   "), STYLE.dim, color);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/core/tests/wizard.test.ts -t "text render"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/render/wizard.ts packages/core/tests/wizard.test.ts
git commit -m "feat(wizard): render text steps with caret, masking, and inline validation"
```

---

### Task 4: Driver wires char/erase + passes title/review

**Files:**
- Modify: `packages/core/src/render/wizard.ts` (`actionFor`, `runWizard`)
- Test: `packages/core/tests/wizard.test.ts` (extend `actionFor` decode test if present, else add)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `actionFor` returns `{ char }` for a printable key, `"erase"` for backspace; `runWizard(steps, color, opts?)` where `opts: { title?: string; review?: boolean; extra?: (s) => string; out?: (s) => void }`.

- [ ] **Step 1: Write the failing test**

```ts
import { actionFor } from "../src/render/wizard";

test("actionFor: printable → char, backspace → erase", () => {
  expect(actionFor("x", { name: "x" })).toEqual({ char: "x" });
  expect(actionFor(undefined, { name: "backspace" })).toBe("erase");
  expect(actionFor(undefined, { name: "up" })).toBe("up");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/tests/wizard.test.ts -t "actionFor: printable"`
Expected: FAIL — `actionFor` returns `null` for `"x"` and has no `erase`.

- [ ] **Step 3: Extend `actionFor`**

In `packages/core/src/render/wizard.ts`, before the final `return null`, add backspace and printable handling (keep the existing arrow/enter/space/`b`/`q` mapping — but note: with text steps, `b`/`q`/space are literal characters, so printable handling must come AFTER the named-key switch yet the single-char `b`/`q` shortcuts now only apply to non-text steps; simplest correct rule: named control keys first, then backspace, then any single printable char becomes `{char}`; drop the `str === "b"/"q"/" "` string shortcuts in favor of named keys `backspace`/`space` and let `b`/`q` be typed text):

```ts
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
  if (str !== undefined && str.length === 1 && str >= " ") {
    return { char: str };
  }
  return null;
}
```

NOTE: this removes the `b`/`q`/`space`-as-string back/cancel shortcuts. Back/cancel now come from named keys (Esc = cancel already; add left-arrow = back is out of scope). To preserve a non-text back/cancel without a Ctrl chord, the driver maps them per step kind — see Step 4.

- [ ] **Step 4: Map `b`/`q` to back/cancel only on non-text steps in the driver**

In `runWizard`'s `onKey`, before calling `actionFor`, special-case `b`/`q` when the active step is not a text step:

```ts
    const onKey = (str: string | undefined, key: IKeyInfo): void => {
      try {
        const step = steps[state.stepIndex];
        const isText = step !== undefined && step.kind === "text";
        let action = actionFor(str, key);
        if (!isText && str === "b") {
          action = "back";
        } else if (!isText && str === "q") {
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
```

Change the `runWizard` signature + internals to take an options object (default preserves current behavior):

```ts
export interface IRunWizardOpts {
  readonly title?: string;
  readonly review?: boolean;
  readonly extra?: (state: IWizardState) => string;
  readonly out?: (s: string) => void;
}

export function runWizard(
  steps: readonly IWizardStep[],
  color: boolean,
  opts: IRunWizardOpts = {}
): Promise<IWizardState> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const extra = opts.extra ?? (() => "");
  const title = opts.title ?? "tsforge setup";
  // …existing body; `draw` uses renderFrame(state, steps, color, extra(state), title)
}
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/core/tests/wizard.test.ts`
Expected: PASS (all wizard tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/render/wizard.ts packages/core/tests/wizard.test.ts
git commit -m "feat(wizard): driver handles text input; options object for title/review"
```

---

### Task 5: Refactor `/setup` onto the generalized `runWizard`

**Files:**
- Modify: `packages/core/src/setup/run-setup.ts` (the `runWizard(...)` call, ~line 108)
- Test: existing `packages/core/tests/*setup*`/`*wizard*` suites (no new test; behavior-preserving)

**Interfaces:**
- Consumes: Task 4 `runWizard(steps, color, opts)`.
- Produces: no new surface; setup now passes `{ title: "tsforge setup", extra }` instead of positional `extra`.

- [ ] **Step 1: Update the call site**

In `packages/core/src/setup/run-setup.ts`, change the positional call to the options form. Find the existing:

```ts
const finalState = await runWizard(steps, color, extra);
```

Replace with:

```ts
const finalState = await runWizard(steps, color, { title: "tsforge setup", extra });
```

(If `out` was passed positionally, move it into the opts object too: `{ title: "tsforge setup", extra, out }`.)

- [ ] **Step 2: Run the setup + wizard suites**

Run: `bun test packages/core/tests/wizard.test.ts && bun test packages/core/tests/setup*.test.ts`
Expected: PASS — output identical to before (title still "tsforge setup", review still on).

- [ ] **Step 3: Real setup smoke (non-interactive path unaffected)**

Run: `bun packages/core/src/cli.ts setup --yes --dir /tmp/wizard-smoke 2>&1 | head`
Expected: writes/【proposes】conventions with no crash (the `--yes` path doesn't open the wizard but exercises the shared config write).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/setup/run-setup.ts
git commit -m "refactor(setup): call the generalized runWizard (title via opts)"
```

---

### Task 6: Real-PTY e2e for the wizard

**Files:**
- Create: `packages/core/scripts/wizard-harness.ts` (a tiny program that runs `runWizard` with a mixed step set and prints the JSON result)
- Create: `scripts/e2e-wizard-pty.py` (drives the harness over a real pty)
- Modify: `package.json` (`e2e:pty` runs the wizard e2e too)

**Interfaces:**
- Consumes: Task 4 `runWizard`.
- Produces: `bun run e2e:pty` also exercises the wizard in a real terminal.

- [ ] **Step 1: Write the harness program**

Create `packages/core/scripts/wizard-harness.ts`:

```ts
import { runWizard } from "../src/render/wizard";
import type { IWizardStep } from "../src/render/wizard.types";

const steps: IWizardStep[] = [
  {
    key: "pick",
    kind: "single",
    title: "Pick one",
    explanation: "choose",
    evidence: [],
    options: [
      { label: "alpha", value: "alpha", recommended: true },
      { label: "beta", value: "beta" },
    ],
  },
  {
    key: "name",
    kind: "text",
    title: "Name",
    explanation: "type a name",
    evidence: [],
    options: [],
    default: "seed",
  },
];

const state = await runWizard(steps, false, { title: "harness", review: false });
process.stdout.write(`\nRESULT ${JSON.stringify({ status: state.status, single: state.single, text: state.text })}\n`);
```

- [ ] **Step 2: Write the pty driver**

Create `scripts/e2e-wizard-pty.py`:

```python
#!/usr/bin/env python3
"""Drive the generic wizard in a REAL pty: pick, type into a text field, confirm."""
import os, pty, select, struct, fcntl, termios, time, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARNESS = os.path.join(REPO, "packages/core/scripts/wizard-harness.ts")

def read_until(m, marker, timeout, buf=""):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        r, _, _ = select.select([m], [], [], 0.3)
        if m in r:
            try:
                d = os.read(m, 65536)
            except OSError:
                break
            if not d:
                break
            buf += d.decode("utf-8", "replace")
            if marker(buf):
                return True, buf
    return False, buf

def main():
    pid, m = pty.fork()
    if pid == 0:
        os.execvpe("bun", ["bun", HARNESS], dict(os.environ, TSFORGE_NO_UPDATE_CHECK="1"))
        os._exit(127)
    fcntl.ioctl(m, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    ok = True
    got, _ = read_until(m, lambda b: "Pick one" in b, 30)
    print(f"  [{'PASS' if got else 'FAIL'}] wizard renders first step")
    ok &= got
    os.write(m, b"\r")            # confirm single (alpha) -> advance to text step
    got, _ = read_until(m, lambda b: "Name" in b, 10)
    print(f"  [{'PASS' if got else 'FAIL'}] advances to the text step")
    ok &= got
    os.write(m, b"\x7f\x7f\x7f\x7f")  # erase "seed"
    os.write(m, b"xy")                 # type "xy"
    os.write(m, b"\r")                 # confirm (review:false) -> apply
    got, buf = read_until(m, lambda b: "RESULT" in b, 10)
    print(f"  [{'PASS' if got else 'FAIL'}] finishes and prints RESULT")
    ok &= got
    good = got and '"status":"apply"' in buf and '"text":{"name":"xy"}' in buf and '"pick":"alpha"' in buf
    print(f"  [{'PASS' if good else 'FAIL'}] result carries single=alpha + text=xy   {buf.split('RESULT')[-1].strip()[:80]!r}")
    ok &= good
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    print("\n==== RESULT:", "ALL PASS" if ok else "FAILURES", "====")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run the wizard pty e2e**

Run: `python3 scripts/e2e-wizard-pty.py`
Expected: `==== RESULT: ALL PASS ====` (4 checks).

- [ ] **Step 4: Wire it into the gate**

In `package.json`, change:

```json
"e2e:pty": "python3 scripts/e2e-pty.py && python3 scripts/e2e-wizard-pty.py",
```

- [ ] **Step 5: Full validate**

Run: `bun run validate`
Expected: green — unit + both pty e2e suites pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/scripts/wizard-harness.ts scripts/e2e-wizard-pty.py package.json
git commit -m "test(wizard): real-pty e2e driving single + text steps"
```

---

## Self-Review

**Spec coverage:**
- Parameterize title → Task 2. ✓
- `text` step kind (default/placeholder/mask/validate) → Tasks 1 (model) + 3 (render) + 4 (input). ✓
- Optional review → Task 2. ✓
- `text` in results (`textValue`) → Task 1. ✓
- Beauty pass (caret/mask/hints/validation) → Task 3. ✓
- Refactor `/setup` onto it → Task 5. ✓
- Keep driver plumbing → only options threaded (Task 4); raw-mode/restore untouched. ✓
- Tests: reducer (1,2), render (3), actionFor (4), setup green (5), real-PTY (6). ✓
- Non-goal (command-menu fold-in) → excluded. ✓

**Placeholder scan:** no TBD/TODO; every code step shows code; test steps show assertions. ✓

**Type consistency:** `IWizardAction` object form `{ char }` used consistently (Task 1 defines, Task 4 emits, reducer consumes); `textValue`/`text` state consistent across 1/3/6; `runWizard(steps, color, opts)` defined in Task 4 and called that way in Tasks 5–6; `renderFrame(..., title)` defined in Task 2, used in Task 3 tests. ✓
