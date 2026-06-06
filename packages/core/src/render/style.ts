/** Terminal ANSI styling — shared by the event renderer and the welcome banner.
 *  ESC is built via fromCharCode so the control byte is unambiguous in source. */
const ESC = String.fromCharCode(27);

export const RESET = `${ESC}[0m`;

export const STYLE = {
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  cyan: `${ESC}[36m`,
  yellow: `${ESC}[33m`,
  magenta: `${ESC}[35m`,
  orange: `${ESC}[38;5;208m`,
} as const;

/** Wrap `text` in an ANSI code when color is on; otherwise return it untouched. */
export function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text;
}
