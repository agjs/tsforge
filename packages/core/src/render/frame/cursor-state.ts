import { SHOW_CURSOR, cup } from "./codes";

/**
 * Dedupes cursor Show/MoveTo so idle/status ticks don't thrash blink
 * (Grok `CursorState` idea).
 */
export class CursorState {
  private row = 0;
  private col = 0;
  private placed = false;

  /** Bytes to place the cursor, or `""` when already there. */
  move(row: number, col: number): string {
    if (this.placed && this.row === row && this.col === col) {
      return "";
    }

    this.row = row;
    this.col = col;
    this.placed = true;

    return SHOW_CURSOR + cup(row, col);
  }

  /** Bytes to position the cursor WITHOUT showing it — for machine-driven
   *  frames that keep the caret hidden until output goes quiet (a SHOW per
   *  frame reads as the caret blinking in step with rendering). */
  placeOnly(row: number, col: number): string {
    if (this.placed && this.row === row && this.col === col) {
      return "";
    }

    this.row = row;
    this.col = col;
    this.placed = true;

    return cup(row, col);
  }

  reset(): void {
    this.placed = false;
    this.row = 0;
    this.col = 0;
  }
}
