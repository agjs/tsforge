const ESC = "\x1b";

/** Home + erase entire display (used on resize so shrunk geometry leaves no ghosts). */
export const CLEAR_SCREEN = `${ESC}[H${ESC}[2J`;

/** Enter the alternate screen buffer and clear the scroll region. */
export const ENTER_ALT = `${ESC}[?1049h${CLEAR_SCREEN}`;

/** Leave the alternate screen buffer. */
export const EXIT_ALT = `${ESC}[?1049l`;

/**
 * Enable SGR mouse reporting (wheel + clicks as CSI sequences).
 * Required so the host terminal does not scroll its own buffer — wheel events
 * come to us and we scroll only the main/panel viewports.
 */
export const ENABLE_MOUSE = `${ESC}[?1000h${ESC}[?1006h`;

/** Disable SGR mouse reporting. */
export const DISABLE_MOUSE = `${ESC}[?1006l${ESC}[?1000l`;

/** Hide / show the cursor. */
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;

/** Blinking block cursor (DECSCUSR). */
export const CURSOR_BLINK_BLOCK = `${ESC}[1 q`;
/** Steady (non-blinking) block — the pane TUI drives its own blink by toggling
 *  visibility, so the terminal's native blink must not fight it. */
export const CURSOR_STEADY_BLOCK = `${ESC}[2 q`;

/** Restore default cursor shape. */
export const CURSOR_SHAPE_DEFAULT = `${ESC}[0 q`;

/** Green caret — matches console bright green (#4ade80). */
export const CURSOR_COLOR_GREEN = `${ESC}]12;#4ade80\x07`;

/** Restore default cursor color. */
export const CURSOR_COLOR_DEFAULT = `${ESC}]112\x07`;

/**
 * Modes the pane TUI turns on that MUST be undone even if `leave()` never ran
 * (SIGINT after the editor closed, a hung planner). `writeSync` this from an
 * exit hook so Node cannot drop the bytes. Safe to emit twice.
 */
export const RESTORE_TERMINAL =
  DISABLE_MOUSE +
  CURSOR_COLOR_DEFAULT +
  CURSOR_SHAPE_DEFAULT +
  SHOW_CURSOR +
  EXIT_ALT;

/** Move cursor to 1-based (row, col). */
export function cup(row: number, col: number): string {
  return `${ESC}[${row};${col}H`;
}

/** Clear from cursor to end of line. */
export const EL_EOL = `${ESC}[K`;

/** Begin / end synchronized update (CSI ?2026) — tear-free frame commits. */
export const BEGIN_SYNC = `${ESC}[?2026h`;
export const END_SYNC = `${ESC}[?2026l`;
