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
} as const;

/** Wrap `text` in an ANSI code when color is on; otherwise return it untouched. */
export function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text;
}
