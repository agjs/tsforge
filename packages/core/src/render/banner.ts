import { STYLE, RESET, paint, truecolor } from "./style";

/**
 * Welcome banner for the interactive CLI — a large "tsforge" wordmark rendered
 * as an ANSI-Shadow figlet with a per-column cyan→indigo→violet gradient, above
 * a dim tagline and the active model/endpoint. Borderless so the wordmark reads
 * as the statement.
 */
export interface IBannerInfo {
  model: string;
  endpoint: string;
  color?: boolean;
}

interface IRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Gradient stops: cyan → indigo → violet (mirrors the omp-style neon ramp). */
const CYAN: IRgb = { r: 34, g: 211, b: 238 };
const INDIGO: IRgb = { r: 99, g: 102, b: 241 };
const VIOLET: IRgb = { r: 168, g: 85, b: 247 };

/** "tsforge" in figlet ANSI-Shadow (59 columns, 6 rows). */
const LOGO: readonly string[] = [
  "████████╗███████╗███████╗ ██████╗ ██████╗  ██████╗ ███████╗",
  "╚══██╔══╝██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝",
  "   ██║   ███████╗█████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ",
  "   ██║   ╚════██║██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ",
  "   ██║   ███████║██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗",
  "   ╚═╝   ╚══════╝╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
];

/** Left indent for every banner line. */
const INDENT = "  ";

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Interpolate the two-segment cyan→indigo→violet ramp at fraction `t` (0..1). */
function rampColor(t: number): IRgb {
  if (t < 0.5) {
    const u = t / 0.5;

    return {
      r: lerp(CYAN.r, INDIGO.r, u),
      g: lerp(CYAN.g, INDIGO.g, u),
      b: lerp(CYAN.b, INDIGO.b, u),
    };
  }

  const u = (t - 0.5) / 0.5;

  return {
    r: lerp(INDIGO.r, VIOLET.r, u),
    g: lerp(INDIGO.g, VIOLET.g, u),
    b: lerp(INDIGO.b, VIOLET.b, u),
  };
}

/** Paint each logo row so color advances by column — a smooth left→right gradient
 *  aligned across every row. */
function gradientLogo(color: boolean): readonly string[] {
  if (!color) {
    return LOGO;
  }

  return LOGO.map((line) => {
    const chars = Array.from(line);
    const span = Math.max(1, chars.length - 1);
    const painted = chars
      .map((ch, i) => {
        const c = rampColor(i / span);

        return `${truecolor(c.r, c.g, c.b)}${ch}`;
      })
      .join("");

    return `${painted}${RESET}`;
  });
}

export function welcomeBanner(info: IBannerInfo): string {
  const color = info.color ?? true;
  const logo = gradientLogo(color).map((line) => `${INDENT}${line}`);
  const tagline = paint(
    `${INDENT}strict TypeScript · gate-driven`,
    STYLE.dim,
    color
  );
  const model =
    `${INDENT}${paint(info.model, STYLE.brand + STYLE.bold, color)}` +
    paint(`  ·  ${info.endpoint}`, STYLE.dim, color);

  return `${["", ...logo, "", tagline, model, ""].join("\n")}\n`;
}
