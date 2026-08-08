/** Terminal ANSI styling — shared by the event renderer and the welcome banner.
 *  ESC is built via fromCharCode so the control byte is unambiguous in source.
 *  Brand truecolor codes mirror apps/docs/src/styles/custom.css (--tf-brand-*). */
const ESC = String.fromCharCode(27);

export const RESET = `${ESC}[0m`;

export const STYLE = {
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  magenta: `${ESC}[35m`,
  /** #3b82f6 — primary brand */
  brand: `${ESC}[38;2;59;130;246m`,
  /** #60a5fa — lighter accent */
  brandLight: `${ESC}[38;2;96;165;250m`,
  /** #2563eb — darker accent */
  brandDark: `${ESC}[38;2;37;99;235m`,
  /** #22d3ee — USER turn cyan */
  cyan: `${ESC}[38;2;34;211;238m`,
  /** #22d3ee — filled USER badge background */
  cyanBg: `${ESC}[48;2;34;211;238m`,
  /** #0a0a0a — ink on filled USER badge */
  ink: `${ESC}[38;2;10;10;10m`,
  /** #52525b — AGENT / input chrome outline (readable on #141414; #3f3f46 vanished) */
  chrome: `${ESC}[38;2;82;82;91m`,
  /** #f4f4f5 — filled AGENT badge background (light pill on dark canvas) */
  chromeBg: `${ESC}[48;2;244;244;245m`,
  /** #0a0a0a — ink on filled AGENT badge */
  chromeInk: `${ESC}[38;2;10;10;10m`,
  /** #ff9900 — plan-mode accent (hairline, rail, body) */
  plan: `${ESC}[38;2;255;153;0m`,
  /** #ff9900 — filled PLAN badge background */
  planBg: `${ESC}[48;2;255;153;0m`,
} as const;

/** Wrap `text` in an ANSI code when color is on; otherwise return it untouched. */
export function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text;
}

/** A 24-bit truecolor foreground SGR code (e.g. for per-character gradients). */
export function truecolor(r: number, g: number, b: number): string {
  return `${ESC}[38;2;${r};${g};${b}m`;
}

/** A 24-bit truecolor background SGR code (opaque canvas fill). */
export function truecolorBg(r: number, g: number, b: number): string {
  return `${ESC}[48;2;${r};${g};${b}m`;
}
