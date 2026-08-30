import type { ILoopEvent } from "../loop/loop.types";
import type { ErrorSet } from "../validate/validate.types";

/**
 * Why a run failed — a structured reason, so every failed run maps to a possible
 * harness intervention (the self-improving north-star). Derived purely from the
 * event stream (+ an optional final gate error set), so the same classifier
 * serves the live loop, the eval sweep, and the offline log analyzer.
 */
export const FAILURE_CLASS = {
  /** The run reached a green gate — no failure. */
  none: "none",
  /** Model emitted tool calls the parser couldn't read (repair L3 / salvage). */
  toolMalformed: "tool-malformed",
  /** Edits/tool calls were rejected — missing target (missing-file / not-found /
   *  ambiguous) or out-of-scope (the dispatcher's tool_rejected). */
  editReject: "edit-reject",
  /** Hit the turn cap or the gate stalled with no decisive error class. */
  noProgress: "no-progress",
  /** Final gate red dominated by tsc type errors. */
  typeError: "type-error",
  /** Final gate red dominated by ESLint rule violations. */
  lintRule: "lint-rule",
  /** Imported a module that doesn't exist (TS2307 / "Cannot find module"). */
  hallucinatedImport: "hallucinated-import",
  /** The typecheck ENVIRONMENT is missing the runtime's type definitions —
   *  builtin modules (`bun:test`, `node:fs`) or runtime globals (`Bun`,
   *  `process`) unresolvable. A gate/tsconfig misconfiguration, not model
   *  error: telling the model to "install the package" sends it chasing
   *  ghosts (observed: a Bun monorepo gated without bun-types → 708 errors,
   *  attributed hallucinated-import, model stuck). */
  missingRuntimeTypes: "missing-runtime-types",
  /** Output degenerated into a repetition loop (StreamGuard fired). */
  degeneration: "degeneration",
  /** A per-call/timeout backstop tripped. */
  timeout: "timeout",
  /** A route rendered as an empty/phantom page. */
  routePhantom: "route-phantom",
  /** The built app failed to render / threw in the browser oracle. */
  browserFail: "browser-fail",
  /** The bundler/build step (vite) failed. */
  buildFail: "build-fail",
  /** Failed, but no signal was decisive. */
  unknown: "unknown",
} as const;

export type FailureClass = (typeof FAILURE_CLASS)[keyof typeof FAILURE_CLASS];

/** Per-signal tallies behind a classification — kept for debugging/telemetry. */
export interface IFailureSignals {
  repairs: number;
  salvages: number;
  editRejects: number;
  degenerated: boolean;
  timedOut: boolean;
  toolUseFailed: boolean;
  tsErrors: number;
  lintErrors: number;
  missingModule: number;
  /** Missing runtime type definitions: cannot-find-name-global codes (TS2580/
   *  TS2591/TS2688/TS2868) + TS2307 on a `bun:`/`node:` BUILTIN specifier. */
  envTypeErrors: number;
  browser: number;
  build: number;
}

export interface IFailureSummary {
  failureClass: FailureClass;
  /** The dominant rule/code for type-error|lint-rule (e.g. "TS18048", "no-as"). */
  detail?: string;
  signals: IFailureSignals;
}

const TS_CODE = /^TS\d+$/;
const MISSING_MODULE = /cannot find module/i;
// Runtime-global lookup failures: "Cannot find name 'Bun'/'process'…" — tsc's
// install-@types hints (2580 node globals, 2591 process, 2688 missing types
// file, 2868 Bun). These NEVER come from model-invented code in a repo that ran
// before; they mean the GATE's tsconfig dropped the runtime's type definitions.
const ENV_GLOBAL_CODES = new Set(["TS2580", "TS2591", "TS2688", "TS2868"]);
// A TS2307 on a runtime BUILTIN specifier (`bun:test`, `node:fs`) is the same
// environment signal — a model cannot hallucinate the runtime's own modules.
const BUILTIN_MODULE = /cannot find module '(?:bun|node):/i;
// The terminal degeneration stops say "repetition loop" (run.ts, session.ts) —
// NOT "degenerate". Match both the user-facing phrase and the internal term.
const DEGENERATE = /repetition loop|degenerat/i;
// Salvage telemetry on the tool channel ("recovered N malformed tool call(s)").
const TOOL_MALFORMED = /salvage|recovered|malformed|re-ask/i;
// Terminal stops where the model never produced usable tool calls: the leaked
// malformed-tool-call stop and the narrate-instead-of-build stop (session.ts).
const TOOL_USE_FAILED =
  /malformed tool-call|writing files as chat|instead of creating them/i;
// Edit/scope rejections surface on TWO channels: model-agent emits a `kind:"edit"`
// "<file> — rejected (<reason>)"; the tool dispatcher emits `kind:"tool"`
// "tool_rejected:" / "tool_input_rejected:". Both contain "reject".
const REJECTED = /reject/i;
// The TERMINAL timeout stop ("timed out repeatedly … stopped"), NOT the transient
// per-turn re-steer ("timed out … re-steering (1/3)") — only the former ends a run.
const TIMED_OUT = /timed out repeatedly/i;
// The actual browser-oracle failure strings (oracle.ts): "rendered blank",
// "app did not mount", "console error:", "uncaught:", "route X failed to load".
const BROWSER = /blank|did not mount|console error|uncaught|failed to load/i;
const ROUTE = /route|phantom|stub/i;
const BUILD = /vite|esbuild|build failed|bundl/i;

/** The most frequently occurring string, or undefined for an empty list. */
function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;

  for (const value of values) {
    const n = (counts.get(value) ?? 0) + 1;

    counts.set(value, n);

    if (n > bestN) {
      bestN = n;
      best = value;
    }
  }

  return best;
}

/** The final red gate's rules: prefer the explicit error set, else the rules
 *  carried on the last failing `validated` event. */
function finalRules(
  events: readonly ILoopEvent[],
  finalErrors?: ErrorSet
): string[] {
  if (finalErrors !== undefined) {
    return finalErrors.flatMap((e) => (e.rule === undefined ? [] : [e.rule]));
  }

  let last: readonly string[] = [];

  for (const event of events) {
    if (event.kind === "validated" && event.passed === false && event.rules) {
      last = event.rules;
    }
  }

  return [...last];
}

/** Concatenated message/output text across the run — for keyword signals that
 *  aren't structured into a dedicated field (missing module, browser, build). */
function runText(
  events: readonly ILoopEvent[],
  finalErrors?: ErrorSet
): string {
  const parts: string[] = [];

  for (const event of events) {
    parts.push(event.message);

    if (event.output !== undefined) {
      parts.push(event.output);
    }
  }

  for (const e of finalErrors ?? []) {
    parts.push(e.message);
  }

  return parts.join("\n");
}

function gatherSignals(
  events: readonly ILoopEvent[],
  finalErrors?: ErrorSet
): IFailureSignals {
  const rules = finalRules(events, finalErrors);
  const text = runText(events, finalErrors);
  // TS2307 in the FINAL gate rules is authoritative. The `runText` keyword scan,
  // by contrast, spans EVERY event message — so a TRANSIENT "cannot find module"
  // from an early turn (e.g. a multi-file task before all siblings exist yet)
  // would permanently trip this and outrank the run's real terminal cause
  // (observed: a test-sibling-required deadlock mislabeled `hallucinated-import`).
  // Only fall back to the text scan when there are NO structured final rules to
  // classify from — i.e. it's a genuine fallback for unstructured logs, not a
  // veto over a decisive gate error.
  //
  // A TS2307 whose message names a runtime BUILTIN (`bun:test`, `node:fs`)
  // counts as an environment error, not a hallucinated import — that split
  // needs the per-error messages, so it only refines the finalErrors path;
  // the rules-only fallback keeps every TS2307 under missingModule.
  const builtin2307 = (finalErrors ?? []).filter(
    (e) => e.rule === "TS2307" && BUILTIN_MODULE.test(e.message)
  ).length;
  const missingModule =
    rules.filter((r) => r === "TS2307").length -
    builtin2307 +
    (rules.length === 0 && MISSING_MODULE.test(text) ? 1 : 0);
  const envTypeErrors =
    rules.filter((r) => ENV_GLOBAL_CODES.has(r)).length + builtin2307;

  return {
    repairs: events.filter((e) => e.kind === "repair").length,
    salvages: events.filter(
      (e) => e.kind === "tool" && TOOL_MALFORMED.test(e.message)
    ).length,
    // Rejections come on both the "edit" channel (model-agent) and the "tool"
    // channel (dispatcher: tool_rejected / tool_input_rejected).
    editRejects: events.filter(
      (e) =>
        (e.kind === "edit" || e.kind === "tool") && REJECTED.test(e.message)
    ).length,
    // `token` events are raw pass-through text (gate/tool output, streamed
    // content) — never a harness-authored signal — so they're excluded here,
    // same as the other kind-scoped signals below. Without this, a gate error
    // that merely MENTIONS a path containing "degenerat" (e.g. a real TS2307
    // on packages/core/tests/run-degenerated.test.ts) trips the regex and
    // masks the actual cause with a false "degeneration" verdict.
    degenerated: events.some(
      (e) => e.kind !== "token" && DEGENERATE.test(e.message)
    ),
    timedOut: events.some((e) => TIMED_OUT.test(e.message)),
    toolUseFailed: events.some((e) => TOOL_USE_FAILED.test(e.message)),
    tsErrors: rules.filter(
      (r) => TS_CODE.test(r) && r !== "TS2307" && !ENV_GLOBAL_CODES.has(r)
    ).length,
    lintErrors: rules.filter((r) => !TS_CODE.test(r)).length,
    missingModule,
    envTypeErrors,
    browser: BROWSER.test(text) ? 1 : 0,
    build: BUILD.test(text) ? 1 : 0,
  };
}

function finalStatusOf(
  events: readonly ILoopEvent[]
): "done" | "stuck" | "none" {
  let status: "done" | "stuck" | "none" = "none";

  for (const event of events) {
    if (event.kind === "done") {
      status = "done";
    } else if (event.kind === "stuck") {
      status = "stuck";
    }
  }

  return status;
}

/** Pick the dominant gate-error class (type vs lint), with its commonest code. */
function classifyGateErrors(
  events: readonly ILoopEvent[],
  finalErrors: ErrorSet | undefined,
  signals: IFailureSignals
): IFailureSummary | undefined {
  const rules = finalRules(events, finalErrors);

  if (signals.tsErrors > 0 && signals.tsErrors >= signals.lintErrors) {
    return {
      failureClass: FAILURE_CLASS.typeError,
      detail: mostCommon(rules.filter((r) => TS_CODE.test(r))),
      signals,
    };
  }

  if (signals.lintErrors > 0) {
    return {
      failureClass: FAILURE_CLASS.lintRule,
      detail: mostCommon(rules.filter((r) => !TS_CODE.test(r))),
      signals,
    };
  }

  return undefined;
}

/** Behavioral fallback when no gate-error class dominates. */
function classifyBehavior(signals: IFailureSignals): FailureClass {
  if (signals.toolUseFailed || signals.salvages > 0 || signals.repairs > 0) {
    return FAILURE_CLASS.toolMalformed;
  }

  if (signals.editRejects > 0) {
    return FAILURE_CLASS.editReject;
  }

  return FAILURE_CLASS.noProgress;
}

/**
 * Classify a run from its event stream. Pass the final gate `ErrorSet` when the
 * caller has it (authoritative); otherwise the classifier falls back to the
 * `rules` carried on the last failing `validated` event and keyword signals.
 * A run that reached a green gate classifies as `none`.
 */
export function classifyRun(
  events: readonly ILoopEvent[],
  finalErrors?: ErrorSet
): IFailureSummary {
  const signals = gatherSignals(events, finalErrors);

  if (finalStatusOf(events) === "done") {
    return { failureClass: FAILURE_CLASS.none, signals };
  }

  // A repeated request timeout is the terminal cause — the model couldn't even
  // respond — so it outranks any stale gate error from an earlier turn.
  if (signals.timedOut) {
    return { failureClass: FAILURE_CLASS.timeout, signals };
  }

  // Likewise a repetition-loop stop: the run died because generation degenerated,
  // not because of whatever the gate last reported.
  if (signals.degenerated) {
    return { failureClass: FAILURE_CLASS.degeneration, signals };
  }

  // Environment errors outrank hallucinated-import: when the gate can't even
  // resolve the runtime's own modules/globals, every other cannot-find-module
  // in the same run is suspect (same broken resolution), and "install the
  // package" guidance would send the model chasing ghosts.
  if (signals.envTypeErrors > 0) {
    return { failureClass: FAILURE_CLASS.missingRuntimeTypes, signals };
  }

  if (signals.missingModule > 0) {
    return { failureClass: FAILURE_CLASS.hallucinatedImport, signals };
  }

  if (signals.browser > 0) {
    const text = runText(events, finalErrors);

    return {
      failureClass: ROUTE.test(text)
        ? FAILURE_CLASS.routePhantom
        : FAILURE_CLASS.browserFail,
      signals,
    };
  }

  if (signals.build > 0 && signals.tsErrors === 0 && signals.lintErrors === 0) {
    return { failureClass: FAILURE_CLASS.buildFail, signals };
  }

  const gate = classifyGateErrors(events, finalErrors, signals);

  if (gate !== undefined) {
    return gate;
  }

  return { failureClass: classifyBehavior(signals), signals };
}

/** Empty signal tallies for a green mid-run settle (no event walk needed). */
function emptySignals(): IFailureSignals {
  return {
    repairs: 0,
    salvages: 0,
    editRejects: 0,
    degenerated: false,
    timedOut: false,
    toolUseFailed: false,
    tsErrors: 0,
    lintErrors: 0,
    missingModule: 0,
    envTypeErrors: 0,
    browser: 0,
    build: 0,
  };
}

/**
 * Live-loop classifier: stamp the CURRENT gate from its ErrorSet (+ optional
 * recent events for behavioral signals). Unlike `classifyRun`, a green gate is
 * `none` even when the event stream has not yet emitted `done` — settle needs
 * that before the done event exists.
 */
export function classifyFromGate(
  gateErrors: ErrorSet,
  events: readonly ILoopEvent[] = []
): IFailureSummary {
  if (gateErrors.length === 0) {
    return { failureClass: FAILURE_CLASS.none, signals: emptySignals() };
  }

  return classifyRun(events, gateErrors);
}

/** Forbidden rationalizations the model must not try for each failure class. */
const ATTRIBUTION_GUIDANCE: Record<FailureClass, string> = {
  [FAILURE_CLASS.none]: "gate is green",
  [FAILURE_CLASS.lintRule]:
    "fix implementation; do not disable, skip, or weaken the rule, and do not " +
    "move the call into an unallowlisted path without updating the rule defaults",
  [FAILURE_CLASS.typeError]:
    "fix types with guards/narrowing; do not cast around the error",
  [FAILURE_CLASS.hallucinatedImport]:
    "if the missing module is an npm package, install it (and `@types/*` if it ships no types) " +
    "before more feature code; only create a local file when the import is a project-relative " +
    "path — do not invent packages",
  [FAILURE_CLASS.missingRuntimeTypes]:
    "the typecheck environment is missing the runtime's type definitions (Bun/Node globals or " +
    "builtin modules) — a gate/tsconfig configuration problem, NOT missing npm packages. Do not " +
    "install packages, create shim files, or edit code to work around unresolvable globals; if a " +
    "tsconfig is in scope, ensure its `types` covers the runtime (e.g. `bun-types`/`@types/bun`, " +
    "`@types/node`) — otherwise raise a hand",
  [FAILURE_CLASS.editReject]:
    "fix the path/scope of the write; do not retry the same rejected target",
  [FAILURE_CLASS.toolMalformed]:
    "emit well-formed tool calls; do not narrate file contents as chat",
  [FAILURE_CLASS.noProgress]:
    "stop micro-patching; rewrite or invert the failing approach — if the block " +
    "stays unclear, raise a hand rather than thrashing",
  [FAILURE_CLASS.degeneration]:
    "stop repeating; take one concrete next step or raise a hand",
  [FAILURE_CLASS.timeout]:
    "infrastructure timeout — raise a hand; do not invent a code fix",
  [FAILURE_CLASS.routePhantom]:
    "wire a real route/page; do not leave stubs that render blank",
  [FAILURE_CLASS.browserFail]:
    "fix the runtime/render failure; do not paper over it in tests alone",
  [FAILURE_CLASS.buildFail]:
    "fix the bundler/build error; do not ignore the build step",
  [FAILURE_CLASS.unknown]:
    "cause is unclear — prefer raising a hand over guessing",
};

/**
 * One-line harness-owned attribution for gate feedback. Empty when the gate is
 * green (`none`) so callers can prepend without a special case.
 */
export function attributionLeadIn(summary: {
  readonly failureClass: FailureClass;
  readonly detail?: string;
}): string {
  if (summary.failureClass === FAILURE_CLASS.none) {
    return "";
  }

  const detail =
    summary.detail !== undefined && summary.detail.length > 0
      ? ` (${summary.detail})`
      : "";
  const guidance = ATTRIBUTION_GUIDANCE[summary.failureClass];

  return `Harness attribution: ${summary.failureClass}${detail} — ${guidance}.`;
}
