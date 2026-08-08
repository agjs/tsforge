import { displayWidth, sliceToWidth } from "../width";
import { RESET } from "../style";
import { stripSgr } from "./ansi-plain";

/**
 * Fit a (possibly ANSI-styled) line into `cols` terminal columns.
 * Preserves SGR when the visible width already fits; truncates to plain text
 * when it doesn't (cutting mid-SGR is worse than dropping color on overflow).
 */
export function fitAnsiLine(line: string, cols: number): string {
  if (cols <= 0) {
    return "";
  }

  const plain = stripSgr(line);
  const width = displayWidth(plain);

  if (width <= cols) {
    return `${line}${RESET}${" ".repeat(cols - width)}`;
  }

  return `${sliceToWidth(plain, cols).text}${RESET}`;
}
