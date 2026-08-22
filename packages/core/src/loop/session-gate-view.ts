import type { IErrorItem } from "../validate/validate.types";
import type { ILoopState } from "./turn";

/** Read-only gate rail snapshot for the TUI (from loop state after settle). */
export interface IGateRailView {
  readonly errors: readonly IErrorItem[];
  readonly errorCount: number;
  /** Checkpoint error count when WS-B has armed a near-green checkpoint. */
  readonly nearGreenCheckpoint?: number;
  readonly nearGreenBest?: number;
  readonly rollbacks?: number;
  /** False when accept/gate command is empty — show "(no gate configured)". */
  readonly gateConfigured: boolean;
}

export function gateRailViewFromState(
  state: ILoopState,
  gateConfigured: boolean
): IGateRailView {
  const count =
    state.lastGateCount >= 0
      ? state.lastGateCount
      : state.prevGateErrors.length;

  return {
    errors: state.prevGateErrors,
    errorCount: count,
    nearGreenCheckpoint: state.nearGreenCheckpoint?.errorCount,
    nearGreenBest: state.nearGreenBest,
    rollbacks: state.nearGreenRollbacks,
    gateConfigured,
  };
}

/** Notify REPL (or other host) that gate rail data changed after settle/rollback. */
export function notifyGateRailChanged(
  ctx: {
    readonly task: { readonly accept: string };
    readonly tool: {
      readonly onGateChanged?: (view: IGateRailView) => void;
    };
  },
  state: ILoopState
): void {
  const gateConfigured = ctx.task.accept.trim().length > 0;

  ctx.tool.onGateChanged?.(gateRailViewFromState(state, gateConfigured));
}
