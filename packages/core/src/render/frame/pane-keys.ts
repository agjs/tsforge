import type { PaneFocus } from "./focus";
import type { Scrollback } from "./scrollback";
import { parseMouseReport } from "./ansi-plain";

export type PaneKeyResult = "handled" | "passthrough" | "dump";

export interface IPaneKeyDeps {
  readonly focus: PaneFocus;
  readonly scrollback: Scrollback;
  readonly panelLen: number;
  /** Wheel: positive = older / up; negative = newer / down. `col` is 1-based. */
  onWheel?(delta: number, col: number, row: number): void;
  paint(): void;
  invalidate(): void;
}

/** Focus / panel navigation keys (Ctrl+G, Esc, Tab, j/k when panel-focused). */
export function handleFocusKey(
  seq: string,
  deps: IPaneKeyDeps
): PaneKeyResult | null {
  if (seq === "\x07") {
    if (deps.focus.togglePanel(deps.panelLen > 0) === "changed") {
      // Layout width changes — invalidate the differential frame, not a body patch.
      deps.invalidate();
      deps.paint();
    }

    return "handled";
  }

  if (seq === "\x1b") {
    if (deps.focus.escape() === "changed") {
      deps.paint();

      return "handled";
    }

    return "passthrough";
  }

  if (seq === "\t") {
    // Don't steal Tab from the prompt editor (indent / completion). Only handle
    // Tab when the panel already owns focus (return to prompt).
    if (!deps.focus.panelFocused) {
      return "passthrough";
    }

    if (deps.focus.tab(deps.panelLen > 0) === "changed") {
      deps.paint();

      return "handled";
    }

    return "passthrough";
  }

  if (!deps.focus.panelFocused) {
    return null;
  }

  const max = Math.max(0, deps.panelLen - 1);
  const up = seq === "\x1b[A" || seq === "\x1bOA" || seq === "k" || seq === "K";
  const down =
    seq === "\x1b[B" || seq === "\x1bOB" || seq === "j" || seq === "J";

  if (up || down) {
    if (deps.focus.moveSelection(up ? -1 : 1, max) === "changed") {
      deps.paint();
    }

    return "handled";
  }

  return null;
}

/**
 * Scrollback / paging keys — only when the user has focused scrollback
 * (or panel arrows are handled above). Prompt-focused arrows stay with the editor.
 */
export function handleScrollKey(
  seq: string,
  deps: IPaneKeyDeps
): PaneKeyResult | null {
  // Don't steal ↑/↓ from the editor while typing.
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
    // Chunk with mouse noise but not a lone report — still swallow if present.
    if (seq.includes(`${String.fromCharCode(27)}[<`)) {
      return "handled";
    }

    return null;
  }

  // 64 = wheel up, 65 = wheel down (SGR). One row per notch — trackpads
  // flood events; PaneScreen coalesces + body-patches so this stays smooth.
  if (report.button === 64 || report.button === 65) {
    const delta = report.button === 64 ? 1 : -1;

    // onWheel owns paint (coalesced). Never invalidate here — that forced a
    // full-frame rebuild per notch and made trackpads feel like molasses.
    deps.onWheel?.(delta, report.col, report.row);
  }

  return "handled";
}
