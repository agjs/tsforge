import type { IResolvedTuiKeybindings } from "../../config/tui-keybindings";
import { matchPaneAction } from "../../config/tui-keybindings";
import type { PaneFocus } from "./focus";
import type { Scrollback } from "./scrollback";
import { parseMouseReport } from "./ansi-plain";

export type PaneKeyResult = "handled" | "passthrough" | "dump";

export interface IPaneKeyDeps {
  readonly focus: PaneFocus;
  readonly scrollback: Scrollback;
  readonly panelLen: number;
  readonly keybindings: IResolvedTuiKeybindings;
  /** When set, caps row selection (Gate rail: error rows only, not detail lines). */
  selectableRowCount?: () => number;
  /** Wheel: positive = older / up; negative = newer / down. `col` is 1-based. */
  onWheel?(delta: number, col: number, row: number): void;
  /** After pane toggle changes layout width — resize the prompt editor + rewrap rail. */
  onLayoutChange?(): void;
  /** Enter on a focused gate row — insert steer text; return true when consumed. */
  onGateEnter?(): boolean;
  /** After pane toggle / surface cycle — recompose rail body. */
  onRailRefresh?(): void;
  paint(): void;
  invalidate(): void;
}

function handleToggle(deps: IPaneKeyDeps): PaneKeyResult {
  if (deps.focus.togglePanel(deps.panelLen > 0) === "changed") {
    deps.invalidate();
    deps.onLayoutChange?.();
    deps.onRailRefresh?.();
    deps.paint();
  }

  return "handled";
}

function handleCycleSurface(deps: IPaneKeyDeps): PaneKeyResult {
  if (deps.focus.cycleSurface() === "changed") {
    deps.onRailRefresh?.();
    deps.paint();
  }

  return "handled";
}

function handleUnfocus(deps: IPaneKeyDeps): PaneKeyResult {
  if (deps.focus.escape() === "changed") {
    deps.paint();

    return "handled";
  }

  return "passthrough";
}

function handleTab(deps: IPaneKeyDeps, seq: string): PaneKeyResult | null {
  if (seq !== "\t") {
    return null;
  }

  if (!deps.focus.panelFocused) {
    return "passthrough";
  }

  if (deps.focus.tab(deps.panelLen > 0) === "changed") {
    deps.paint();

    return "handled";
  }

  return "passthrough";
}

function handlePanelNav(seq: string, deps: IPaneKeyDeps): PaneKeyResult | null {
  if (!deps.focus.panelFocused) {
    return null;
  }

  const action = matchPaneAction(seq, deps.keybindings);

  if (action === "pane.moveUp" || action === "pane.moveDown") {
    const max = Math.max(0, (deps.selectableRowCount?.() ?? deps.panelLen) - 1);
    const delta = action === "pane.moveUp" ? -1 : 1;

    if (deps.focus.moveSelection(delta, max) === "changed") {
      if (deps.focus.railSurface === "gate") {
        deps.onRailRefresh?.();
      }

      deps.paint();
    }

    return "handled";
  }

  if (
    (seq === "\r" || seq === "\n") &&
    deps.focus.railSurface === "gate" &&
    deps.onGateEnter?.() === true
  ) {
    deps.paint();

    return "handled";
  }

  return null;
}

/** Focus / panel navigation keys (configurable via tui.keybindings). */
export function handleFocusKey(
  seq: string,
  deps: IPaneKeyDeps
): PaneKeyResult | null {
  const action = matchPaneAction(seq, deps.keybindings);

  if (action === "pane.toggle") {
    return handleToggle(deps);
  }

  if (action === "pane.cycleSurface") {
    return handleCycleSurface(deps);
  }

  if (action === "pane.unfocus" || seq === "\x1b") {
    return handleUnfocus(deps);
  }

  const tab = handleTab(deps, seq);

  if (tab !== null) {
    return tab;
  }

  return handlePanelNav(seq, deps);
}

/**
 * Scrollback / paging keys — only when the user has focused scrollback
 * (or panel arrows are handled above). Prompt-focused arrows stay with the editor.
 */
export function handleScrollKey(
  seq: string,
  deps: IPaneKeyDeps
): PaneKeyResult | null {
  if (
    deps.focus.promptFocused &&
    !deps.focus.panelFocused &&
    (seq === "\x1b[A" ||
      seq === "\x1bOA" ||
      seq === "\x1b[B" ||
      seq === "\x1bOB")
  ) {
    return null;
  }

  if (seq === "\x1b[A" || seq === "\x1bOA") {
    if (deps.focus.active === "prompt") {
      deps.focus.focusScrollback();
    }

    deps.scrollback.scroll(1);
    deps.paint();

    return "handled";
  }

  if (seq === "\x1b[B" || seq === "\x1bOB") {
    deps.scrollback.scroll(-1);

    if (deps.scrollback.following) {
      deps.focus.focusPrompt();
    }

    deps.paint();

    return "handled";
  }

  if (seq === "\x1b[5~") {
    deps.scrollback.scroll(10);
    deps.paint();

    return "handled";
  }

  if (seq === "\x1b[6~") {
    deps.scrollback.scroll(-10);
    deps.paint();

    return "handled";
  }

  return null;
}

/** Swallow SGR mouse reports; wheel scrolls main or panel via onWheel. */
export function handleMouseKey(
  seq: string,
  deps: IPaneKeyDeps
): PaneKeyResult | null {
  const report = parseMouseReport(seq);

  if (report === null) {
    if (seq.includes(`${String.fromCharCode(27)}[<`)) {
      return "handled";
    }

    return null;
  }

  if (report.button === 64 || report.button === 65) {
    const delta = report.button === 64 ? 1 : -1;

    deps.onWheel?.(delta, report.col, report.row);
  }

  return "handled";
}
