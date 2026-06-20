import type { ILoopEvent } from "../loop";
import { STYLE, RESET } from "./style";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_TICK_MS = 120;
const ERASE_LINE = `\r${String.fromCharCode(27)}[2K`;

/** Minimal stdout surface the spinner needs — injectable so the inline-write
 *  behaviour is unit-testable without touching the real terminal. */
export interface ISpinnerOut {
  write: (s: string) => void;
  isTTY?: boolean;
}

/** Animated activity line (`⠋ thinking · 12s`) for the silent stretches of a
 *  turn — hidden chain-of-thought, prompt processing, a slow first token. TTY
 *  only. Any rendered event clears it before printing (the next tick redraws),
 *  so it never interleaves with streamed text or boxes. */
export function makeSpinner(out: ISpinnerOut = process.stdout): {
  start: () => void;
  clear: () => void;
  stop: () => void;
  setLabel: (label: string) => void;
  onTick: (cb: () => void) => void;
  setInlineGate: (fn: () => boolean) => void;
  frameLabel: () => string;
  /** Advance one frame and (if the inline gate allows) write the activity line.
   *  Exposed for deterministic tests; the live spinner drives it via setInterval. */
  tick: () => void;
} {
  let timer: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;
  let frame = 0;
  let drawn = false;
  let label = "thinking";
  let onTickCb: (() => void) | null = null;
  // When the status bar is active it shows the activity itself, so the inline
  // write (which lands on the readline input line and erases what the user is
  // typing) is suppressed. Default true for the no-bar fallback (pipes, tiny TTY).
  let inlineGate: () => boolean = () => true;

  const secsNow = (): number =>
    startedAt === 0 ? 0 : Math.round((performance.now() - startedAt) / 1000);

  const clear = (): void => {
    if (drawn) {
      out.write(ERASE_LINE);
      drawn = false;
    }
  };

  const tick = (): void => {
    frame = (frame + 1) % SPINNER_FRAMES.length;

    if (inlineGate()) {
      out.write(
        `${ERASE_LINE}  ${STYLE.dim}${SPINNER_FRAMES[frame] ?? ""} ${label} · ${secsNow()}s${RESET}`
      );
      drawn = true;
    }

    onTickCb?.(); // repaint the pinned status bar with live activity / tok/s
  };

  return {
    tick,
    setInlineGate: (fn: () => boolean): void => {
      inlineGate = fn;
    },
    frameLabel: (): string =>
      timer === null
        ? ""
        : `${SPINNER_FRAMES[frame] ?? ""} ${label} · ${secsNow()}s`,
    start: (): void => {
      if (out.isTTY !== true || timer !== null) {
        return;
      }

      label = "thinking";
      startedAt = performance.now();
      timer = setInterval(tick, SPINNER_TICK_MS);
    },
    clear,
    stop: (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }

      clear();
    },
    setLabel: (l: string): void => {
      label = l;
    },
    onTick: (cb: () => void): void => {
      onTickCb = cb;
    },
  };
}

/** What the spinner should say given the latest event — the activity line
 *  follows the turn's phase instead of claiming "thinking" during a gate run
 *  or a dependency install. Null = keep the current label. */
export function spinnerPhase(event: ILoopEvent): string | null {
  if (event.kind === "token") {
    if (event.channel === "tool") {
      return "writing";
    }

    return event.channel === "reasoning" ? "thinking" : null;
  }

  if (event.kind === "run" || event.kind === "validated") {
    return "checking";
  }

  if (event.kind === "tool" && /install/i.test(event.message)) {
    return "installing deps";
  }

  return event.kind === "cycle" ? "thinking" : null;
}
