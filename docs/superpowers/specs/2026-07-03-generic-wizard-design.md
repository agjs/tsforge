# Generic wizard primitive — design

## Context

tsforge needs a beautiful, reusable wizard so in-harness UX (the coming `/config`,
"add a model", and the existing `/setup`) all render from **one** primitive instead
of duplicating keypress/alt-screen/selection logic. See
`2026-07-03-config-ux-design.md` — that feature consumes this one.

`render/wizard.ts` already implements a solid wizard, but it is coupled to `setup`:
a hardcoded "tsforge setup" header, an always-on Review/Apply overview, and only
single/multi-select steps (no free-text). The work is to **generalize it in place**,
not rewrite it — its pure state model and its hard-won interactive driver (alt-screen,
safe raw-mode, listener stash/restore, EPIPE-guarded exit) stay.

## Keep (already good)
- Pure model: `initWizard` / `reduceWizard` / `driveWizard` — testable without a TTY.
- Back-and-forth nav: `b` back, `enter` advance, `q`/Esc cancel, overview back.
- `single` and `multi` step kinds with recommended tags, evidence, outcome, notes.
- The `runWizard` driver: alt-screen, raw-mode ownership logic, listener restore,
  exception-safe `finish`. Untouched.

## Changes (what makes it generic + beautiful)

### 1. Parameterize the title
`renderStep`/`renderOverview` hardcode `"tsforge setup"`. Add a `title` to the wizard
config (default `"tsforge"`); setup passes `"setup"`, config passes `"config"`, etc.

### 2. New `text` step kind
The blocker for "add a model" (baseUrl / model / apiKey are free text).
`IWizardStep.kind` gains `"text"`, with:
- `placeholder?` / `default?` — seed value shown when empty / prefilled.
- `mask?: boolean` — render as bullets (apiKey / secrets).
- `validate?(value): string | null` — inline error message, blocks `confirm` until valid.

State: add `text: Readonly<Record<string, string>>` to `IWizardState`, plus a
transient edit buffer for the active text step. Reducer gains character/backspace
handling for text steps; the key→action decode gains `"char"` and `"erase"` actions
(printable input + backspace) that only apply on a text step. All still pure.

### 3. Optional review screen
Add `review?: boolean` to the wizard config (default `true` for guided flows). When
`false`, confirming the last step finishes with status `"apply"` directly — right for
a quick single-pick ("switch model") where a Review page is friction.

### 4. Results shape
`runWizard` already returns `IWizardState`; callers read `state.single` / `checkedValues`.
Add `state.text` and a `textValue(state, step)` helper so a caller gets every answer by
`step.key`, regardless of kind.

### 5. Beauty pass
- Consistent header: `title` + `Step X of N · <step title>` + a rule.
- Clear active-row highlight (existing `›` gutter + brand color), recommended tag,
  multi checkboxes `◉/◯` (existing), and for `text` a visible caret + masked bullets.
- A single, consistent key-hint footer per kind (e.g. text: `type   enter continue   b back   q cancel`).
- Validation errors render inline under the field in the warn color.

## Refactor `/setup` onto it
`setup/wizard-flow.ts` already builds `IWizardStep[]` and `run-setup.ts` already calls
`runWizard`. The only changes: pass `title: "setup"` and (unchanged) its `extra`
config-preview for the overview. This turns setup into a *caller* of the generic
primitive — the de-duplication the user asked for — with no behavior change.

## Non-goals
- Not folding `command-menu.ts` (the `/` palette) into the wizard now. It could later
  be expressed as a 1-step single-select, but coupling it in adds risk for no v1 gain.
- No new theming system — reuse the existing `STYLE` palette.

## Testing
- **Pure reducer** (extend existing wizard tests): `text` entry (type/erase/validate),
  optional-review flow (last-step confirm → apply when `review:false`), title param,
  results include `text`. `driveWizard([...actions])` asserts final state.
- **Key→action decode** (`actionFor`): printable → `char`, backspace → `erase`,
  existing arrows/enter/back/cancel unchanged.
- **Existing setup wizard tests stay green** (the refactor is behavior-preserving).
- **Real-PTY e2e** (new, in the gate): spawn a tiny harness that runs `runWizard` with
  a mixed step set (single + text + multi), drive it over a real pty (arrow, type
  chars, backspace, `b` back, `enter`), and assert the rendered frames + final
  `{single, multi, text}` result. Verifies the primitive works in a real terminal —
  not just the reducer.

## Rollout
1. Generalize `render/wizard.ts` (title, `text` kind, optional review, `text` results)
   + beauty pass + unit tests.
2. Refactor `/setup` onto it; confirm setup tests + a real setup run are unchanged.
3. Real-PTY e2e for the wizard.
Then the config-ux spec builds `/config` and add-model as flows on this base.
