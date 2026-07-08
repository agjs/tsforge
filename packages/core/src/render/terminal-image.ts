/**
 * Inline image rendering for terminals that support it. Today only the iTerm2
 * inline-image protocol (OSC 1337) is implemented — it's what the user's terminal
 * speaks, and unlike Kitty/Sixel it accepts JPEG/PNG/GIF/WebP as-is (no local
 * decode/convert). Kitty and Sixel are deliberate follow-ups.
 *
 * The module is pure string/encoding + capability detection so it's trivially
 * testable; the REPL decides WHEN to emit (and falls back to printing a path when
 * the protocol is `none`).
 */
export type ImageProtocol = "iterm2" | "none";

const ITERM2_PREFIX = "\x1b]1337;File=";
const ITERM2_TERMINATOR = "\x07";

/** The env vars `detectImageProtocol` consults (a subset of `process.env`). */
export type IDetectImageEnv = Readonly<Record<string, string | undefined>>;

/** Which inline-image protocol the current terminal supports. An explicit
 *  `TSFORGE_IMAGE_PROTOCOL` (`iterm2` | `off`/`none`) wins so a user can force or
 *  disable it; tmux is treated as unsupported (passthrough is unreliable and can
 *  corrupt the pane). Otherwise iTerm2 is detected via its session env vars. */
export function detectImageProtocol(
  env: IDetectImageEnv = process.env
): ImageProtocol {
  const forced = env.TSFORGE_IMAGE_PROTOCOL;

  if (forced === "iterm2") {
    return "iterm2";
  }

  if (forced === "off" || forced === "none") {
    return "none";
  }

  if (env.TMUX !== undefined && env.TMUX.length > 0) {
    return "none";
  }

  if (
    (env.ITERM_SESSION_ID !== undefined && env.ITERM_SESSION_ID.length > 0) ||
    env.TERM_PROGRAM === "iTerm.app"
  ) {
    return "iterm2";
  }

  return "none";
}

export interface IEncodeImageOptions {
  /** File name shown by the terminal (base64-encoded per the protocol). */
  name?: string;
  /** Width in terminal cells (e.g. `40`). Omitted → `auto`. */
  widthCells?: number;
  /** Height in terminal cells. Omitted → `auto`. */
  heightCells?: number;
}

/** Build the iTerm2 OSC-1337 inline-image escape sequence for base64 image data
 *  (no data-URI prefix). Aspect ratio is preserved; width/height default to
 *  `auto` so the terminal sizes the image sensibly. */
export function encodeITerm2(
  base64: string,
  opts: IEncodeImageOptions = {}
): string {
  const params = [
    "inline=1",
    `width=${opts.widthCells === undefined ? "auto" : String(opts.widthCells)}`,
    `height=${opts.heightCells === undefined ? "auto" : String(opts.heightCells)}`,
    "preserveAspectRatio=1",
    ...(opts.name === undefined
      ? []
      : [`name=${Buffer.from(opts.name).toString("base64")}`]),
  ].join(";");

  return `${ITERM2_PREFIX}${params}:${base64}${ITERM2_TERMINATOR}`;
}

/** Encode `base64` for the given protocol, or `null` when inline rendering isn't
 *  supported (caller should print a path instead). */
export function renderInlineImage(
  base64: string,
  protocol: ImageProtocol,
  opts: IEncodeImageOptions = {}
): string | null {
  return protocol === "iterm2" ? encodeITerm2(base64, opts) : null;
}

/** A tiny budget so a burst of generated images can't flood the scrollback. Not
 *  a hard requirement for iTerm2 (emit-and-forget), but keeps a runaway loop from
 *  dumping hundreds of images. `take()` returns false once the cap is reached. */
export function makeImageBudget(max = 8): {
  take: () => boolean;
  used: () => number;
} {
  let used = 0;

  return {
    take() {
      if (used >= max) {
        return false;
      }

      used += 1;

      return true;
    },
    used: () => used,
  };
}
