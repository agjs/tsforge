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
  const missingModule =
    rules.filter((r) => r === "TS2307").length +
    (MISSING_MODULE.test(text) ? 1 : 0);

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
    degenerated: events.some((e) => DEGENERATE.test(e.message)),
    timedOut: events.some((e) => TIMED_OUT.test(e.message)),
    toolUseFailed: events.some((e) => TOOL_USE_FAILED.test(e.message)),
    tsErrors: rules.filter((r) => TS_CODE.test(r) && r !== "TS2307").length,
    lintErrors: rules.filter((r) => !TS_CODE.test(r)).length,
    missingModule,
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
