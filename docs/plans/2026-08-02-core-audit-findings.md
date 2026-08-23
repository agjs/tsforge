# Core harness audit — findings ledger

> Pass 1 (priority tier / #105 blast radius), started 2026-08-02 against `main` @ `78af10fb`
> (v0.35.0, clean tree). Execution plan: `/Users/ag/.claude/plans/squishy-gathering-hollerith.md`.
> Handoff/rationale: `docs/plans/2026-08-02-core-harness-audit.md`.
> **Report-first pass — no code changes, no PRs.** BoringStack adapter out of scope.

## Decision log

**2026-08-02, ag: the shell stays unbounded by the editable scope — F16, F22 and F23 are DEFERRED,
not open work.** `run` deliberately hands the model a real shell; the editable scope constrains the
edit TOOLS, not the shell, and the guard around redirects is best-effort steering rather than
containment. Known and accepted, so do not re-litigate it or "fix" the redirect scanner: a scanner
over command text cannot bound a shell. If it is ever revisited, the recommended route is outcome-
based (snapshot before `run`, revert writes outside the scope after, reusing `loop/file-snapshot.ts`)
rather than another pass at parsing commands. The partial text-based attempt lives on the unpushed
branch `fix/run-redirect-out-of-scope-guard` and is expected to be discarded.

## How to read this

- **Severity** — **P1** correctness/safety (silent gate loss, a guard that doesn't guard, a
  kill that leaks); **P2** partial fix, missing test, hidden failure; **P3** clarity/robustness.
- **Status** — `CONFIRMED` = I ran the repro in the main session and it fired.
  `UNPROVEN` = reported but the repro did not fire (or none exists); kept with what was tried,
  never silently promoted or dropped. Discovery agents produce hypotheses; only a fired repro
  makes a finding.

## Status

| Unit | Scope | State |
|------|-------|-------|
| A1 | `gate/*`, `validate/*` | done — F7, F8 |
| A2 | cli seam (`args.ts`, `repl.ts`, `gate-setup.ts`, `session-store.ts`, `config/*`) | done — F2, F3, F5, F6 |
| A3 | `loop/greenfield/*` | done — F9 |
| A4 | `loop/turn.ts`, `session.ts`, `run.ts`, `loop.types.ts` | done — F14, F15 |
| A5 | `loop/tools/*` (excl. boringstack) | done — no findings (see Cleared hunches) |
| A6 | `policy/*` | done — **F16**, F17 |
| A7 | cross-cutting mechanical sweeps | done — F1, F4, F10; `as`/disable/empty-catch/platform sweeps clean |
| — | `eval` / `self-harness` (out of pass-1 scope; raised by ag's local model, verified here) | F11, F12, F13 |

**Pass 1 totals: 19 findings — 3 P1, 10 P2, 6 P3. Every one reproduced in the main session
except F15, which is explicitly recorded as UNPROVEN on this platform.**

### Landing status

| PR | Findings | State |
|----|----------|-------|
| [#223](https://github.com/boringstack-xyz/tsforge/pull/223) — `fix/gate-never-silently-drops-rule-packs` | F1, F4 (+ F19 documented) | **MERGED** as `db6ba79e`. Panel PASS r5. |
| [#224](https://github.com/boringstack-xyz/tsforge/pull/224) — `fix/profiles-never-lower-below-pack-default` | F2, F20 (+ class guard; F21 raised) | panel **PASS** (r2, 4 reviewers / 0 errored, no findings); validate green, 3352 tests. **Awaiting ag's signed merge.** |
| next | F3, F5 (args parser) | not started |
| next | F14 (normalization) | not started |
| next | F7, F8, F9, F12 (small fixes) | not started |
| next | F6, F10, F18 (manifest + orphan docs) | not started |
| held | F16 — needs ag's call on approach (denylist vs allowlist vs shell grammar) | not started |
| separate | F11, F13 (eval cost + acceptance CI) | not started |

**Note on F1:** the audit under-stated it. It is not only a typo path — the documented `plugins`
feature triggered it on every run. Measured: an external pack id yields 10 `tsforge/*` rules
in-process and 0 in the spawned gate.

## Findings

### F1 — P1 — A pack-load failure silently drops EVERY stack rule pack from the gate

- **status:** CONFIRMED (repro run in main session)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/strict.eslint.config.mjs:53`
  and `/Users/ag/Documents/Code/tsforge/packages/core/strict.web.eslint.config.mjs:51`
- **evidence:** both bundled gate configs wrap the whole pack load in
  `try { … buildPackEslintConfig(packIds, ruleOverrides) … } catch { /* silently continue without them */ }`.
  `buildPackEslintConfig` throws for the WHOLE list if any single id is unknown
  (`rule-packs/index.ts:141`) or if two packs collide (`:150`). So one bad id ⇒ zero packs,
  no warning, gate still green. Measured by loading the real bundled config per env:

  | `TSFORGE_PACKS` | `tsforge/*` rules in the gate config |
  |---|---|
  | `react,drizzle` | **10** |
  | `react,drizzle,typo-pack` | **0** |
  | `react,drizzle,constructor` | **0** |
  | *(unset)* | 0 |

  A one-character typo makes the gate config byte-equivalent to "no packs at all".
- **reachability (this is what makes it P1):** `resolveActivePacks` *deliberately adds*
  unrecognised `packs.include` ids to the active list — it only warns
  (`config/tsforge-config.ts:715-725`, verified: `resolveActivePacks([], {packs:{include:["not-a-pack"]}})`
  → `["not-a-pack"]`). `config.stack` is added at `:704` with **no validation and no warning**
  at all. Those ids flow to `TSFORGE_PACKS` via `packEnvPrefix` (`gate/shell.ts:27`) from
  `gate/core-gate.ts:167`. So a typo in a user's `tsforge.config.json` silently disables every
  framework rule — the exact failure class as #105 (greenfield never enforcing framework rules).
- **repro:**
  `TSFORGE_PACKS="react,drizzle,typo-pack" bun -e 'const c=(await import("/Users/ag/Documents/Code/tsforge/packages/core/strict.eslint.config.mjs")).default; console.log(c.flatMap(b=>Object.keys(b?.rules??{})).filter(r=>r.startsWith("tsforge/")).length)'`
  → prints `0`; drop `,typo-pack` → prints `10`. **FIRED.**
- **fix sketch:** the catch must not be silent and must not be all-or-nothing.
  (a) Validate ids where they enter — `resolveActivePacks` should *drop* an unknown
  `packs.include` id (and validate `config.stack`) rather than pass it through, so the gate
  never receives an id that can throw. (b) In both `.mjs` configs, keep a catch only for the
  *import* failure, and on any failure write a loud line to `stderr` naming the packs that were
  dropped — silently weakening the gate is the one thing this repo forbids. Mirror the existing
  precedent in the same files, where the convention block deliberately defaults to house style
  "so a failed import NEVER silently drops the enum ban" (`strict.eslint.config.mjs:58-61`).
- **regression test:** `tests/gate-packs.test.ts` — "an unknown pack id does not drop the
  valid packs' rules" + "resolveActivePacks drops unknown include ids".

### F16 — P1 — Seven standard shell idioms walk straight through the critical-deny set

- **status:** CONFIRMED end-to-end (detector **and** policy verdict; nothing was executed —
  every command was passed as a STRING to the detectors and to `evaluatePolicy`)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/policy/patterns.ts:24-32`
  (`COMMAND_WRAPPERS`), `:94-101` (`unquote`), `:109-138` (`shellSegments`), `:157-172` (`pipesToShell`)
- **evidence:** the manifest's stated invariant is that the critical-deny set holds *"in EVERY
  mode, `bypassPermissions` included"*, and that the shell detectors *"see through the disguises
  a naive head-check misses"*. The known disguises are covered — but these are not:

  | command | `isDestructiveShell` | verdict in `bypassPermissions` |
  |---|---|---|
  | `rm -rf /` *(control)* | DENIED | **deny** — "destructive shell command blocked" |
  | `sudo rm -rf /`, `env VAR=x rm -rf /`, `f() { rm -rf /; }`, `( rm -rf x )` *(controls)* | DENIED | deny |
  | `curl x \| sh` *(control)* | — | **deny** — "piping into a shell interpreter blocked" |
  | `timeout 10 rm -rf /` | **escapes** | **allow** (`mode:bypassPermissions`) |
  | `eval 'rm -rf /'` | **escapes** | **allow** |
  | `$'rm' -rf /` (ANSI-C quoting) | **escapes** | **allow** |
  | `find . \| xargs rm -rf /` | **escapes** | **allow** |
  | `exec rm -rf /` | **escapes** | **allow** |
  | `builtin rm -rf /` | **escapes** | **allow** |
  | `sh <<< 'rm -rf /'` (here-string) | **escapes** `pipesToShell` | **allow** |

  The controls proving the detectors and the harness are otherwise working is what makes this
  conclusive: the same call path denies `rm -rf /` and allows `xargs rm -rf /`. In
  `bypassPermissions` the critical-deny set is the *entire* remaining defence, so an `allow` here
  is the guard failing exactly where it is the only guard. `xargs rm -rf` is not an exotic
  construction — it is the single most common real-world form of the command.
- **repro:** `/private/tmp/.../scratchpad/policy-evasion.ts` (detector level) and
  `policy-verdict.ts` (`classifyAction` → `evaluatePolicy`, `mode: "bypassPermissions"`).
  **FIRED, 7/7.**
- **fix sketch:** three distinct gaps, not one:
  1. `COMMAND_WRAPPERS` is missing `timeout`, `xargs`, `exec`, `builtin` (note `timeout` and
     `xargs` take their own leading options, so the wrapper-skip needs argument handling like the
     existing `-exec` case, not just set membership).
  2. `shellSegments` extracts interpreter `-c` bodies but not `eval` bodies — add the same
     extraction so the body is analysed as a segment.
  3. `unquote` handles `'…'`/`"…"` but not `$'…'`; `pipesToShell` splits on `|` but not `<<<`.

  Given that this is the third distinct gap found in one pass, the durable fix is a decision
  about approach: a denylist of shell syntaxes will keep losing this race. Worth considering an
  allowlist for `run` in `bypassPermissions`, or parsing with a real shell grammar instead of
  regex segmentation. Flagging as a design question for ag, not something to patch blind.
- **regression test:** `tests/policy-evaluation.test.ts` — extend the existing evasion table with
  all seven, asserting at the `evaluatePolicy`/`bypassPermissions` level (not just the detector),
  so a future refactor can't pass the unit while re-opening the hole.

### F17 — P3 — `evaluatePolicy` is not fail-closed on an invalid mode

- **status:** CONFIRMED behavior; **reachability UNPROVEN** (every current entry point validates)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/policy/policy.ts:490-491`
  (`MODE_MATRIX[ctx.mode][action.kind]`)
- **evidence:** a bare index on the mode. Measured: `mode:"not-a-mode"` → **throws**
  `undefined is not an object (evaluating 'MODE_MATRIX[ctx.mode][action.kind]')`;
  `mode:"constructor"` and `mode:"toString"` → **no throw**, verdict `decision: undefined`,
  reason `mode:constructor`. A verdict that is neither `allow` nor `deny` is decided by whatever
  truthiness check the caller applies — the F4 prototype-key class again, this time in the
  security layer. It is not promoted higher because all five entry points do validate first
  (`cli.ts:397`, `cli/repl.ts:490` and `:736`, `config/recipes.ts:122`,
  `config/tsforge-config.ts:441`, all via `isPolicyMode`), so no reachable path was found.
- **fix sketch:** look the mode up with `Object.hasOwn` and return a hard `deny` when it is
  unknown — a security evaluator should fail closed by construction, not by the discipline of its
  five callers.
- **regression test:** `tests/policy-evaluation.test.ts` — "an unknown or prototype-named mode
  denies".

### F2 — P1 — The strictest profile (`opinionated`) lowers a rule below its pack default

- **status:** CONFIRMED (repro run in main session)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/config/profiles.ts:105`
- **evidence:** `"max-hooks-per-file": "warn"` sits three lines under a comment that states the
  rule for this exact situation (`:99-101`): *"`error`, NOT `warn` — the strictest profile must
  never lower a quality rule below the default."* The pack default is `error`
  (`rule-packs/react-component-architecture/index.ts:51`). Effective severity through the real
  builder, pack `react-component-architecture`:

  | profile | effective `tsforge/max-hooks-per-file` |
  |---|---|
  | *(no profile)* | `error` |
  | `recommended` / `strict` | *(removed — intended: structure rules are opt-in)* |
  | `opinionated` | **`warn`** ← relaxation |

  `opinionated` re-enables the structure rules at `error` for six of seven rules and leaves this
  one at `warn`. This is the identical defect #105 fixed one line above for
  `no-inline-jsx-functions` — the fix was applied to that line only, not to its neighbour.
- **repro:** `buildPackEslintConfig(["react-component-architecture"], resolveProfileRuleOverrides("opinionated")).rules["tsforge/max-hooks-per-file"]`
  → `"warn"`; without overrides → `"error"`. **FIRED.**
- **fix sketch:** `"max-hooks-per-file": "error"`. Then make the class impossible rather than
  point-fixing a third time: a test that walks EVERY profile against EVERY pack's `rulesConfig`
  and fails if any override is strictly weaker than the pack default (`off < warn < error`),
  except where the profile deliberately removes a structure rule.
- **regression test:** `tests/profiles.test.ts` — "no profile lowers any rule below its pack
  default" (table-driven over all profiles × all packs).

### F3 — P2 — Every value-taking flag swallows the next token, even when it is a flag

- **status:** CONFIRMED (repro run in main session)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/cli/args.ts:244`
- **evidence:** the guard is `VALUE_FLAGS.has(arg) && argv[i + 1] !== undefined` — presence
  only, never "is the next token itself a flag". Actual `parseArgs` output:

  | argv | result |
  |---|---|
  | `--notify --continue` | `notify:"--continue"`, **`continue:false`** (resume silently lost) |
  | `--files --web` | `files:["--web"]`, **`web:false`** |
  | `--accept --no-gate` | `accept:"--no-gate"`, **`noGate:false`** |
  | `--dir --plan` | **`dir:"<cwd>/--plan"`**, `plan:false` (path-joined) |
  | `--profile --help` | `profile:"--help"`, `help:false` |

  #105 added `profileFlagError` for exactly this shape, but only for `--profile`; the other ten
  `VALUE_FLAGS` (`--notify --browser --accept --files --base --policy-mode --recipe --resume
  --dir --gate`) still fail silently. The repo's own standard here is fail-loudly.
- **repro:** `bun -e 'import {parseArgs} from "…/src/cli/args"; console.log(parseArgs(["--notify","--continue"]))'` → `notify:"--continue", continue:false`. **FIRED.**
- **fix sketch:** fix it at the parser, not per flag: when a `VALUE_FLAG`'s next token is
  absent or is itself a known flag, emit the same loud error `profileFlagError` produces, for
  every value flag. Generalising the existing helper also removes the per-flag duplication
  (DRY, standing bar). Note `--accept` legitimately takes a value containing spaces/dashes
  (`--accept "bun test -- x.ts"`), so key the check on "next token is in `BOOL_FLAGS`/`VALUE_FLAGS`",
  not on a leading `-`.
- **regression test:** `tests/cli.test.ts` — "a value flag followed by a flag errors instead of
  swallowing it", table-driven over all `VALUE_FLAGS`.

### F4 — P2 — `in`-operator pack lookups reintroduce the prototype-key hole #105 fixed for profiles

- **status:** CONFIRMED (repro run in main session)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/rule-packs/index.ts:56`
  (`id in RULE_PACKS`) and `:138` (`packId in PACK_REGISTRY`);
  `/Users/ag/Documents/Code/tsforge/packages/core/src/config/tsforge-config.ts:709`, `:720`
- **evidence:** `isProfileId` was fixed to `Object.hasOwn` with an explicit comment — *"`in`
  walks the prototype chain, so `constructor`/`toString`/`__proto__` would falsely validate"*
  (`config/profiles.ts:117-119`). Four sibling lookups on the same kind of
  user/config-supplied key still use `in`. Consequences, measured:
  - `resolveActivePacks([], {packs:{include:["constructor"]}})` → `["constructor"]` with **no
    "unknown pack" warning**, whereas `"not-a-pack"` correctly warns. The prototype key is the
    one case that evades the diagnostic.
  - `buildPackEslintConfig(["constructor"])` → `isRulePackId` returns true → `lookupPack`
    returns `Object` (the constructor function) typed as `IRulePack` → `Object.entries(pack.rules)`
    on `undefined` → **`TypeError: Object.entries requires that input parameter not be null or
    undefined`**, instead of the designed `Unknown rule pack: constructor`. Same for `toString`,
    `valueOf`. Via F1's swallow, that TypeError then silently zeroes the gate's packs.
- **repro:** `/private/tmp/.../scratchpad/repro-packid-proto.ts` — control `"not-a-pack"` warns
  + throws `Unknown rule pack`; `"constructor"`/`"toString"`/`"valueOf"` do neither. **FIRED.**
- **fix sketch:** replace all four `in` lookups with `Object.hasOwn`, matching `isProfileId`.
  This is a recurring class — worth a lint rule or a single shared `isKnownKey(registry, id)`
  helper so the next registry can't reintroduce it (DRY).
- **regression test:** `tests/rule-packs.test.ts` + `tests/tsforge-config.test.ts` — "prototype
  keys are rejected like any other unknown id" over `["constructor","toString","valueOf","__proto__"]`.

### F5 — P3 — `profileFlagError` reports the flag name as part of the offending value

- **status:** CONFIRMED
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/cli/args.ts` (`profileFlagError`)
- **evidence:** `profileFlagError(["--profile","bogus"])` →
  `unknown --profile "--profile,bogus" — valid: …`. The quoted value should be `bogus`; it is
  the joined argv slice including the flag itself. Misleads on a plain typo.
- **fix sketch:** report only the token after the flag (or `(missing)` when absent).
- **regression test:** `tests/cli.test.ts` — assert the exact message for `["--profile","bogus"]`.

### F6 — P3 — The review manifest is silent on the CLI seam it most recently churned

- **status:** CONFIRMED (absence verified)
- **location:** `/Users/ag/Documents/Code/tsforge/docs/harness-subsystems.md`
- **evidence:** `cli/args.ts`, `cli/repl.ts`, `cli/gate-setup.ts`, `session-store.ts`,
  `config/profiles.ts`, `config/tsforge-config.ts` appear in no manifest entry, yet they carried
  most of #105 and three findings above. The manifest is the review contract; a core seam absent
  from it is never adversarially reviewed. (The skill states a stale manifest is itself a finding.)
- **fix sketch:** add a `## cli / args + session` entry with the invariants the findings above
  imply: value flags never swallow a flag; no profile lowers a rule below its pack default;
  precedence is explicit CLI > resumed session > config > default; resumed values are re-validated
  before use.

### F7 — P3 — `genericErrors` truncates gate output silently; its sibling announces truncation

- **status:** CONFIRMED (repro run in main session)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/validate/parse.ts:44`
- **evidence:** `return text.length > 0 ? [{ key: "raw", message: text.slice(0, 500) }] : [];`
  — a hard 500-char cut with no marker. The sibling fallback in the same subsystem does the
  opposite: `` `${cleaned.slice(0, FALLBACK_CAP)}\n… (output truncated)` ``
  (`validate/validate.ts:26`). Measured: `genericErrors("E".repeat(700))` → message length 500,
  ends mid-`E`, contains no "truncat" marker. **FIRED.** This is the fallback path for any
  command with no tool-specific parser (e.g. a project's own test command), so the model is the
  consumer of the cut-off text and gets no signal that more errors exist.
- **fix sketch:** reuse the existing announce-on-truncate form from `validate/validate.ts:26`
  rather than re-rolling a second cap — extract one shared `capWithNotice(text, cap)` used by
  both (DRY, standing bar).
- **regression test:** `tests/parse.test.ts` — "genericErrors announces truncation past the cap".

### F8 — P2 — The conventions half of the gate cache key has no test

- **status:** CONFIRMED (code correct, coverage absent)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/tests/gate-incremental.test.ts:157-184`
- **evidence:** the cache path is hashed from the full env prefix, which includes
  `TSFORGE_CONVENTIONS` (`gate/shell.ts:36-40`, `gate/core-gate.ts:30`), and it genuinely works —
  measured on a real temp project: no conventions → `.tsforge/eslint-gate-89hbv2qb4sb8.cache`,
  with `{interfaces:"bare-pascal-case"}` → `.tsforge/eslint-gate-3iumt74opsblc.cache`. But the
  existing test only covers packs and rule overrides; `grep -n conventions
  tests/gate-incremental.test.ts` returns nothing. A wrong-keyed gate cache is precisely the #105
  defect, so this invariant needs a test guarding it, not just correct code.
- **fix sketch:** extend the existing "keys the eslint cache path by the active ruleset" test
  with a conventions case.
- **regression test:** `tests/gate-incremental.test.ts` — "buildGate keys the eslint cache path
  by conventions".

### F9 — P3 — `isFeatureId` accepts double hyphens its own comment says it rejects

- **status:** CONFIRMED (repro run in main session)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/loop/greenfield/state.ts:19-23`
- **evidence:** the comment claims *"true kebab-case, so `a`/`a-b` pass but `a-`/`-a`/`a--`-with-trailing
  don't"*, but `[a-z0-9-]*` permits runs of hyphens. Measured: `a--b` → `true`, `a---b` → `true`;
  `a-`, `-a`, `A-b`, `../x`, `""` → `false`. **FIRED.** No safety impact — traversal vectors are
  correctly rejected, and the id is not used as a path component in core — so this is a contract
  /comment mismatch, not a hole.
- **fix sketch:** `/^[a-z0-9]+(?:-[a-z0-9]+)*$/u`, which is what the comment describes.
- **regression test:** `tests/greenfield-planner.test.ts` — add `test--item`, `a---b` to the
  unsafe-id drop table.

### F10 — P2 — The manifest's `gate` entry lists a file that no longer exists and omits the one holding the gate abstraction

- **status:** CONFIRMED
- **location:** `/Users/ag/Documents/Code/tsforge/docs/harness-subsystems.md:110-114`
- **evidence:** the entry states `src/gate/* = core-gate.ts, web-gate.ts, linter.ts, tsconfig.ts,
  shell.ts, test-discovery.ts, tool-paths.ts, types.ts`. Actual contents: `core-gate.ts`,
  **`gate-runner.ts`**, `index.ts`, `linter.ts`, `shell.ts`, `test-discovery.ts`, `tool-paths.ts`,
  `tsconfig.ts`. `web-gate.ts` **does not exist**; `gate-runner.ts` — which defines `IStage`,
  `IGate`, `composeGate`, `commandGate`, `differentialStage`, i.e. the composable gate the
  greenfield loop runs — appears nowhere in the manifest (`grep -c gate-runner` → 0).
  The review contract therefore points a reviewer at a deleted file and away from the gate
  abstraction. (Noted because the pass-1 `gate` review agent reported the subsystem "secure"
  without catching this, despite the manifest-staleness instruction — a reminder that an agent's
  "clean" is a hypothesis too.)
- **fix sketch:** update the entry to the real file list and give `gate-runner.ts` its own
  invariants (stage short-circuit order, a failing stage never yielding green).
- **regression test:** none possible directly; the durable fix is the manifest-vs-`ls` drift
  check suggested under "Follow-ups".

### F11 — P2 — The eval record is blind to cost, the one metric that decides whether a harness change ships

- **status:** CONFIRMED (out of pass-1 scope — surfaced by ag's local model, verified here)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/eval/eval.types.ts:22-37`
  (`IRunRecord`) and `:39-62` (`IVariantSummary`)
- **evidence:** `IRunRecord` carries `label, passed, cycles, ms, quality?, loc?, failureClass?`
  and `IVariantSummary` carries `runs, passed, passRate, avgCycles, avgTurnsToGreen, avgMs,
  avgQuality, avgLoc, failureClasses`. Neither carries tokens or cost. Yet `src/eval/metrics.ts`
  already computes `tokensOut` (`:19`, accumulated `:103`), `peakContext` (`:21`, `:104`) and
  `costPerAcceptedChange` (`:33`, `:177-178`) — those surface only in the log trace
  (`src/eval/trace.ts:43-48`), never in the A/B sweep record. So a variant that raises pass-rate
  a few points while costing 3× more tokens scores as a straight win.
- **fix sketch:** add `tokensOut` / `costPerAcceptedChange` to `IRunRecord`, average them into
  `IVariantSummary`, and print them in the sweep report next to `passRate`.
- **regression test:** `tests/eval-metrics.test.ts` — "a run record carries token cost" +
  "summarize averages cost across runs".

### F12 — P2 — `avgMs` is always 0 in every self-harness campaign (a metric that reads as measured but is a placeholder)

- **status:** CONFIRMED
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/self-harness/evaluate.ts:211`
  and `:298`
- **evidence:** both `IRunRecord` construction sites hardcode `ms: 0`. `IVariantSummary.avgMs`
  (`eval/eval.types.ts:52`) therefore averages zeros and reports `0` for every variant of every
  self-harness campaign, while presenting as a real wall-clock figure. This is the "text that
  lies about state" class the manifest calls out for tools, applied to a metric.
- **fix sketch:** plumb the real elapsed time from `runSpec` into the record, or drop the field
  from the self-harness path rather than emitting a fabricated zero.
- **regression test:** `tests/self-harness-evaluate.test.ts` — "a completed run records non-zero ms".

### F13 — P2 — The self-harness acceptance rule ignores the Wilson-CI / z-test machinery the repo already ships

- **status:** CONFIRMED
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/self-harness/evaluate.ts:19`
  (imports) and `src/self-harness/validate.ts:56` (the acceptance metric)
- **evidence:** `src/eval/report.ts` implements `wilsonInterval` (`:29`), attaches a 95% Wilson
  CI per variant (`:101`) and marks two-proportion z-test significance vs baseline (`:167`), and
  it is exported from `src/eval/index.ts:18`. But `self-harness/evaluate.ts` imports only
  `classifyRun, countTaskLoc, judge, summarize` — never `buildReport`/`wilsonInterval` — and
  `self-harness/report.ts` contains no CI or significance logic at all (grep for
  `wilson|interval|significan` → no matches). So the rule that decides whether a harness change
  is accepted compares raw point estimates across a handful of repeats, with no confidence
  bound, even though the machinery to do it properly sits one import away.
- **fix sketch:** route the self-harness summary through `buildReport` so acceptance requires a
  significant, not merely nominal, improvement. Pure reuse — no new statistics code (DRY).
- **regression test:** `tests/self-harness-validate.test.ts` — "a nominal but non-significant
  improvement is not accepted".

### F14 — P2 — `organize_imports` is the one write path that scope-checks the raw model argument

- **status:** CONFIRMED (structural, platform-independent)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/loop/tools/lsp-ops.ts:142`
- **evidence:** `doOrganizeImports` calls `writable(file, ctx.files)` on the argument straight
  from `fileArg(args)`. Every other write path normalizes first — `file-ops.ts:45`, `:505`,
  `:640` (`doEdit`), `:856` (`doCreate`) all call `normalizeWorkspacePath(ctx.cwd, …)` before the
  scope check. `lsp-ops.ts` does not even import the helper (its imports are `relative`,
  `fileArg/TOOL_NAME`, `runArgvCommand`, `writable`, `LOOP_LIMITS`, `tool-context`). This is
  exactly the manifest's stated risk for this subsystem: *"scope check on the raw arg instead of
  the normalized written path."* The un-normalized path is then also what gets reported in the
  rejection message and in `mutated`, so the change scope records a different string than the
  other tools would.
- **fix sketch:** normalize once at the top of `doOrganizeImports` and use the normalized value
  for the scope check, the reject message, `svc.organizeImports`, and the `mutated` payload —
  matching `doEdit`/`doCreate`. Better still, hoist the normalize-then-`writable` pair into one
  shared helper so a future tool cannot forget it (DRY, standing bar).
- **regression test:** `tests/tool-accounting.test.ts` — "organize_imports normalizes the path
  before the scope check" (an absolute in-workspace path must be accepted, as it is for `edit`).

### F15 — P3 — Scope matching does not normalize path separators (Windows-only impact)

- **status:** **UNPROVEN on this platform** — behavior confirmed, impact not reproducible on macOS
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/lib/scope/scope.ts:12-28`
- **evidence (measured):** `new Bun.Glob("src/**").match("src\\util.ts")` → `false`;
  `normalizeWorkspacePath("/tmp/p", "src\\util.ts")` → `"src\\util.ts"` (separators preserved);
  `isInScope("src\\util.ts", ["src/**"])` → `false`.
- **why it is not promoted:** on macOS/Linux a backslash is a legal filename character, so
  treating `src\util.ts` as a distinct path is *correct* here — the repro cannot fire on this
  platform. The claimed impact is Windows-only, where `node:path`'s `relative`/`resolve` return
  backslash separators natively, so `normalizeWorkspacePath` would emit `src\util.ts` and every
  scope check against `src/**` patterns would reject the model's own writes. The repo does treat
  Windows as a supported platform (`lib/platform.ts` ships `isWin32()`), so this is worth a
  Windows CI check rather than a blind fix — normalizing separators unconditionally would change
  correct POSIX behavior.
- **fix sketch:** normalize separators only under `isWin32()`, reusing the existing helper; add a
  Windows job to CI, or explicitly document Windows as unsupported and drop `isWin32()`.
- **regression test:** `tests/scope.test.ts` — a platform-gated case asserting Windows separators
  resolve into scope.

### F18 — P3 — `strict.web.eslint.config.mjs` is a published export with no producer

- **status:** CONFIRMED (surfaced while fixing F1)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/strict.web.eslint.config.mjs`
- **evidence:** repo-wide grep for `strict.web.eslint` finds it only in
  `packages/core/package.json:22` (the `files` array — so it ships to npm) and in the new
  `tests/gate-pack-load.test.ts`. Nothing in `src/` builds a command against it, and there is no
  `web-gate.ts` (F10). It is a maintained, shipped file — it had to receive the same F1 fix — but
  nothing in the harness invokes it. Either it is a deliberate public export for consumers to
  point eslint at (in which case it should be documented as such), or it is a leftover of the
  removed web-gate path and should go.
- **fix sketch:** decide which, then either document it in `reference/` or delete it from
  `files` and the tree. Do not delete silently — it is published, so removal is a breaking change
  for anyone consuming it.

### F19 — P2 — External plugin CONTENT is not frozen, so a workspace-local plugin can weaken its own gate

- **status:** CONFIRMED by inspection; raised by the review panel against the F1 fix and
  **deliberately not fixed there**
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/gate/pack-config.ts`
  (documented inline as a known limitation)
- **evidence:** #105 froze the gate policy — rule overrides, profile, conventions, and the test
  command are captured once so the subject cannot relax its own gate mid-run. Plugin packs are
  now the exception: only the plugin *specs* are frozen, and each spawned gate re-imports the
  path, so a plugin file living inside the workspace can be edited between cycles to drop or
  weaken its rules under the same pack id. The eslint cache key covers the spec, not the module's
  content.
- **why it was not fixed inline:** freezing requires a content hash captured at policy time and
  verified in the gate, and an entry-file hash does not cover a plugin's transitive imports — a
  design decision in its own right. The F1 fix is still strictly stronger than what it replaced
  (where a configured plugin silently dropped *every* pack, built-ins included), so shipping it
  is not gated on this.
- **fix sketch:** capture a hash over each plugin's resolved module graph at gate-policy capture,
  pass it alongside the specs, and hard-fail in the gate when it no longer matches. Alternatively
  restrict plugin paths to outside the editable scope.
- **regression test:** "a plugin edited mid-session fails the gate instead of weakening it".

### F20 — P1 — The `frontend` profile weakened two React correctness rules below the default profile

- **status:** CONFIRMED and FIXED in [#224](https://github.com/boringstack-xyz/tsforge/pull/224)
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/config/profiles.ts` (frontend
  `ruleOverrides`)
- **evidence:** the block set three rules to `warn`; measured against the packs, one was a no-op and
  two were downgrades — `no-html-img-element` is already `warn` in the nextjs pack, while
  `no-anonymous-useEffect` and `no-derived-state-in-effect` are `error` in
  react-component-architecture and untouched by `recommended`. So `--profile frontend` was weaker
  on two React correctness rules than the default profile. The no-op indicates the block was
  authored without checking pack severities.
- **fix:** all three overrides removed; pack severities stand. ag's decision.

### F21 — P3 — The `frontend` profile is now inert (identical to `backend`)

- **status:** CONFIRMED (consequence of F20's fix) — **not changed, product decision**
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/config/profiles.ts`
- **evidence:** with the two downgrades removed, `frontend.ruleOverrides` equals
  `backend.ruleOverrides` exactly (`structureOffOverrides`) and it declares no `extraPacks`, so
  selecting it changes nothing. Its only distinguishing content was the relaxation.
- **fix sketch:** give it `extraPacks` that actually mean "frontend" (react,
  react-component-architecture, nextjs), or drop the profile. Needs ag's call.

### F23 — P1 — Shell-write detection cannot bound `run`, and is not a security boundary

- **status:** CONFIRMED by the review panel at **agreement 3** — the strongest consensus in this
  audit. Partially mitigated; **the class is unfixable by this approach and needs ag's decision.**
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/loop/tools/file-ops.ts`
  (`shellWriteTargets` / `findProjectWrite`)
- **what was fixed:** `runShell` refused a redirect target only when it was *writable*, so every
  path the editable scope EXCLUDED fell through. Measured: `edit secret.ts` → "REJECTED: out of
  scope", while `run` with `echo pwned > secret.ts` → `exit 0` and the file overwritten. It now
  also refuses an EXISTING in-workspace file that is out of scope. (Creating a NEW out-of-scope
  file stays allowed — a task may run with no editable scope and legitimately write a marker;
  refusing every in-workspace target broke three repair-loop tests.)
- **what cannot be fixed this way:** the guard reads redirect targets out of command TEXT, and
  command text cannot be resolved without executing it. All of these defeat it:
  `echo x > "$f"` (resolved at runtime), `echo x > "a file.ts"` and `echo x > a\ file.ts`
  (the separator the scanner splits on), and `sed -i` / `cp` / `tee` / any script (no redirect at
  all). This is structurally the same problem as **F16**: enforcing a boundary by pattern-matching
  shell syntax is a race the guard loses.
- **the honest position, now stated in the code:** this is best-effort **steering** — keeping the
  model from reaching for `cat > src/foo.ts` out of edit-tool friction, plus closing the easy
  overwrite — and NOT containment. What actually bounds `run` is the policy layer.
- **decision needed (ag):** F16, F22 and this are one question — *what actually contains the
  shell?* Options: confine `run`'s cwd; run it in a sandbox/container; allowlist commands rather
  than denylist syntax. Iterating on the regex is not a fourth option.
- **regression tests:** `tests/execute-tool.test.ts` — refuse-existing-out-of-scope,
  allow-create-new (both with and without an editable scope), allow-outside-workspace;
  `tests/scope.test.ts` — `insideWorkspace` segment semantics.

### F22 — P3 — The `run` shell is not bounded by the editable scope (deliberate; worth a decision)

- **status:** CONFIRMED behavior, **deliberate and pre-existing** — surfaced by the review panel
  during the F14 fix, not introduced by it. Not changed.
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/loop/tools/file-ops.ts:499-507`
- **evidence:** `runShell` refuses a redirect only when the target resolves as *writable* — i.e.
  in the editable scope. Out-of-scope and traversal targets execute. Measured: with
  `files: ["impl.ts"]`, `run` with `echo pwned > ../escaped.ts` returns `exit 0` and the file
  appears **outside the workspace**.
- **why it is deliberate:** the check exists to stop the model writing PROJECT files via a shell
  redirect, which would bypass the write guard, the per-file lint feedback, and hashline
  snapshots — not to sandbox the shell. The code says so ("/tmp + out-of-scope targets are
  fine") and `tests/execute-tool.test.ts` already asserts `/tmp` and build-log redirects are
  allowed. The manifest likewise calls `run` "the one deliberate shell form". Its reach is
  governed by the **policy layer** (destructive-shell detection, private-key denial, plan-mode
  read-only), not by the editable scope.
- **why it is still worth ag's attention:** the editable scope reads like a containment boundary
  and is not one. Anyone reasoning "the model can only touch `task.files`" is wrong wherever
  `run` is available. This compounds **F16** — the policy layer *is* the boundary for `run`, and
  F16 shows seven standard shell idioms walking through it.
- **fix sketch:** none applied. Options, all ag's call: leave as-is and document the boundary
  explicitly in the docs; or confine `run`'s cwd/redirects for untrusted targets. Decide
  together with F16, since they concern the same guard.
- **regression test:** the behavior is now pinned in `tests/execute-tool.test.ts`
  ("run's shell is NOT bounded by the editable scope (documented behavior)") so a future change
  to it is a deliberate one, not a silent drift.

### F24 — P3 — `backend` is a no-op alias for `recommended` (same class as F21)

- **status:** CONFIRMED (surfaced by the review panel while removing `frontend`) —
  **not changed, product decision**
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/config/profiles.ts`
- **evidence:** measured against `recommended`, `backend` declares no `extraPacks`, no
  `metaRulesAtError`, and the identical `structureOffOverrides`. Its ONLY difference is
  omitting `prefer-early-return: "warn"` — and that rule's own pack default is `warn`
  (`code-flow` pack), so the override it omits was a no-op anyway. Selecting `--profile
  backend` therefore does exactly what the default does.
- **why it matters:** this is the same dead-profile class `frontend` was removed for
  (F21). `frontend` at least *used* to differ, by relaxing two rules; `backend` has
  never differed. Its description ("stack detection adds Fastify/Elysia/Drizzle/BullMQ
  packs") describes what stack DETECTION does for any profile, not what this profile
  adds.
- **fix sketch:** either give it real `extraPacks` (fastify/elysia/drizzle/bullmq, which
  is what its description implies) or delete it as F21 did. Needs ag's call.
- **note:** `tests/profiles.test.ts` asserts the current five ids as a drift guard, with
  a comment recording that this entry is under review — so the assertion is not read as
  endorsement.

### F24 — P3 — `backend` was a no-op alias for `recommended` (same class as F21)

- **status:** CONFIRMED and REMOVED, on ag's call, in the same PR as F21
- **location:** `/Users/ag/Documents/Code/tsforge/packages/core/src/config/profiles.ts`
- **evidence:** measured against `recommended`, `backend` declared no `extraPacks`, no
  `metaRulesAtError`, and the identical `structureOffOverrides`. Its ONLY difference was
  omitting `prefer-early-return: "warn"` — and that rule's own pack default IS `warn`
  (the `code-flow` pack), so the omitted override was a no-op. `--profile backend` did
  exactly what the default did.
- **why it counted:** the same dead-profile class as F21. `frontend` at least *used* to
  differ (by relaxing two React rules); `backend` never differed at all. Its description
  ("stack detection adds Fastify/Elysia/Drizzle/BullMQ packs") describes what stack
  DETECTION does for every profile, not what this one added.
- **fix:** removed. Profiles are now `recommended`, `strict`, `security`, `opinionated`.
  `tests/profiles.test.ts` asserts that exact set and rejects both removed ids, and its
  comment records the standard: a profile must differ from `recommended` by more than
  nothing.
- **surfaced by:** the review panel, while reviewing the F21 removal — it noticed the PR
  was deleting one dead profile while pinning another as intended.

## Cleared hunches

_(hypotheses whose repro did not fire — recorded so they aren't re-chased)_

- **`isProfileId` prototype pollution** — fixed and holding: uses `Object.hasOwn`
  (`config/profiles.ts:119`). Verified directly.
- **`--profile` specifically swallowing the next flag** — the value is still mis-parsed
  (F3), but `profileFlagError` does catch `["--profile","--help"]` and fails the run loudly, so
  `--profile` alone is not silently wrong. The other ten value flags have no such guard.
- **`eslint-disable` directives in core `src/`** — zero. All 17 matches are the *rule that bans
  them* plus prompt text. House rule holds.
- **Empty `catch {}` blocks in core `src/`** — zero by grep across 485 files.
  (The silent catches that do exist are in the bundled `.mjs` configs — see F1.)
- **Scattered `process.platform` comparisons (the #104 DRY class)** — clean. `lib/platform.ts:5`
  exports `isWin32()` and the only remaining raw uses (`lib/clipboard/clipboard-image.ts:49,142`)
  pass the value as a field rather than comparing it.
- **`tools` subsystem (A5)** — reported clean by its agent against every manifest invariant
  (mutation-reports-only-on-real-change for all 7 mutating handlers, no handler throwing into the
  loop, plan-mode dispatch guard, `Object.hasOwn` on the handler registry, argv-only shell calls,
  the exhaustive classification test at `tests/tool-accounting.test.ts:459-469`). Recorded as
  *not independently re-verified* — and note it reviewed `organize_imports` and did **not** catch
  F14, which the `loop/turn` agent found in the same file. Treat "clean" as the weakest result
  in this ledger.
- **Cost/CI machinery "missing" from the repo** — false. `src/eval/report.ts` really does
  implement `wilsonInterval` (`:29`), a 95% CI per variant (`:101`) and a two-proportion z-test
  vs baseline (`:167`), and `src/eval/metrics.ts` really does compute `tokensOut` and
  `costPerAcceptedChange`. The defect is that the self-harness path doesn't *consume* either —
  see F11 and F13. The machinery exists; the wiring doesn't.
- **`harness-review` "defers to the project's own weak validate script"** — misapplied. It does
  spawn `bun run validate` (`cli/harness-review-mode.ts:193`), but `harness-review` reviews
  *tsforge's own repo*, where `validate` IS tsforge's strict gate (`check:bun` + typecheck +
  lint + `format:check` + test + `e2e:pty`). The "never defer to the project's own lint script"
  principle governs *target* repos the harness builds, not tsforge reviewing itself.

## Follow-ups (not findings — worth a task each)

- **The recurring class problem.** F2, F4, F14 and F17 are each *the same defect one line, one
  registry, or one call site over* from a fix that already landed. Three of #105's fixes were
  applied at the failing line rather than to the class. The high-leverage work is the class-level
  guards: a table-driven profile-vs-pack severity test (kills F2's class), one shared
  `isKnownKey(registry, id)` (F4, F17), one shared normalize-then-`writable` helper (F14), one
  parser-level value-flag guard (F3).
- **Ad-hoc truncation caps.** Seven distinct `.slice(0, N)` caps with no shared helper
  (`validate/parse.ts:44`, `inference/openai-compatible.ts:133`, `inference/image-gen.ts:100,249,254`,
  `inference/vision.ts:92`, `self-harness/evaluate.ts:108`); only `loop/feedback/rule-docs.ts:620`
  announces the cut. One `capWithNotice(text, cap)` would fix F7 and the class together.
- **Manifest drift check.** F10 (a listed file that doesn't exist, an existing file that holds
  the gate abstraction and is unlisted) plus F6 (the whole CLI seam unlisted) argue for a cheap
  test that diffs each manifest entry's globs against the real tree.
- **Unreferenced exports (20).** Not dead-code-confirmed — a sweep for exported symbols with no
  reference anywhere in `packages/core` (src + tests + scripts + `.mjs`). Notable:
  `files/hashline-format.ts` (7 constants), `elysia/utils/elysiaChain.ts` (4 helpers),
  `lib/fs/process.ts:4 readProcessOutput`, `gate/tool-paths.ts:103 STUB_CHECK`,
  `mcp/jsonrpc.ts:54 isResponseFor`, `editor/segments.ts:13 graphemeCount`. Each needs a
  judgement call (public API vs genuinely dead) before removal.
