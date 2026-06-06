import type { IRenderOptions } from "./render.types";
import { highlight } from "cli-highlight";
import type { ILoopEvent } from "../loop";

const RESET = "[0m";
const STYLE = {
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  green: "[32m",
  cyan: "[36m",
  yellow: "[33m",
};

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text;
}

function highlightTs(code: string, color: boolean): string {
  if (!color) {
    return code;
  }

  try {
    return highlight(code, { language: "typescript", ignoreIllegals: true });
  } catch {
    return code;
  }
}

function gutter(block: string, color: boolean): string {
  const bar = paint("│", STYLE.dim, color);

  return block
    .split("\n")
    .map((line) => `  ${bar} ${line}`)
    .join("\n");
}

function diff(oldString: string, newString: string, color: boolean): string {
  const minus = oldString
    .split("\n")
    .map((l) => paint(`- ${l}`, STYLE.red, color))
    .join("\n");
  const plus = newString
    .split("\n")
    .map((l) => paint(`+ ${l}`, STYLE.green, color))
    .join("\n");

  return `${minus}\n${plus}`;
}

/**
 * Format a loop event for a terminal (ANSI) or a plain log (`color: false`).
 * The library emits structured events; this renderer is the only place that
 * knows about colors/layout — a web UI could render the same events differently.
 */
export function renderEvent(
  event: ILoopEvent,
  opts: IRenderOptions = {}
): string {
  const color = opts.color ?? true;

  switch (event.kind) {
    case "token":
      // The model's streamed reasoning — dim, so it reads as secondary thinking
      // beneath the bright highlighted code/actions.
      return paint(event.message, STYLE.dim, color);

    case "start":
    case "fix":
      return `\n${paint(event.message, STYLE.dim, color)}\n`;

    case "cycle":
      return `\n${paint(`── ${event.message} ──`, STYLE.cyan + STYLE.bold, color)}\n`;

    case "create": {
      const head = `\n  ${paint(`✚ ${event.message}`, STYLE.green + STYLE.bold, color)}\n`;

      return event.content === undefined
        ? head
        : `${head}${gutter(highlightTs(event.content, color), color)}\n`;
    }

    case "edit": {
      const head = `\n  ${paint(`✎ ${event.message}`, STYLE.cyan + STYLE.bold, color)}\n`;

      if (event.oldString === undefined || event.newString === undefined) {
        return head;
      }

      return `${head}${gutter(diff(event.oldString, event.newString, color), color)}\n`;
    }

    case "red":
      return `\n${paint(`✗ ${event.message}`, STYLE.red + STYLE.bold, color)}\n`;

    case "stuck":
      return `\n${paint(`✗ ${event.message}`, STYLE.red + STYLE.bold, color)}\n`;

    case "validated":
      return event.passed === true
        ? `${paint(`  ✓ ${event.message}`, STYLE.green, color)}\n`
        : `${paint(`  • ${event.message}`, STYLE.yellow, color)}\n`;

    case "done":
      return `\n${paint(`✓ ${event.message}`, STYLE.green + STYLE.bold, color)}\n`;

    case "run": {
      const exit =
        event.exitCode === undefined
          ? ""
          : paint(
              ` → exit ${event.exitCode}`,
              event.exitCode === 0 ? STYLE.green : STYLE.red,
              color
            );
      const head = `\n  ${paint(event.message, STYLE.yellow + STYLE.bold, color)}${exit}\n`;
      const out =
        event.output !== undefined && event.output.length > 0
          ? `${gutter(event.output, color)}\n`
          : "";

      return `${head}${out}`;
    }

    case "tool":
      return `  ${paint(event.message, STYLE.dim, color)}\n`;

    case "timing":
      return `${paint(`  ⏱ ${event.message}`, STYLE.dim, color)}\n`;

    default:
      return `\n${event.message}\n`;
  }
}
