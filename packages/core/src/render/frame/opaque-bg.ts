import { RESET } from "../style";

/**
 * Stamp an opaque background onto a (possibly SGR-styled) line so transparent
 * terminals cannot show wallpaper through blank cells.
 *
 * `paint()` / `fitAnsiLine()` emit full SGR resets, which also clear background.
 * Re-apply `bg` after every reset, and leave `bg` active at the end so a
 * following EL (erase-to-EOL) can fill with BCE when the terminal supports it.
 */
export function withOpaqueBg(line: string, bg: string): string {
  if (bg.length === 0) {
    return line;
  }

  return `${bg}${line.split(RESET).join(`${RESET}${bg}`)}`;
}
