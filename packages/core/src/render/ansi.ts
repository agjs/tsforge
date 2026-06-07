import type { IRenderOptions, IStatusInfo } from "./render.types";
import { highlight } from "cli-highlight";
import type { ILoopEvent } from "../loop";
import type { IChatMessage } from "../inference";
import { STYLE, paint } from "./style";

/** Compact token count: 1234 → "1.2k", 14000 → "14k". */
function humanCount(n: number): string {
  if (n < 1000) {
    return String(n);
  }

  const k = n / 1000;

  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
}

/** Compact duration: 9000 → "9s", 84000 → "1m24s". */
function humanDuration(ms: number): string {
  const total = Math.round(ms / 1000);

  if (total < 60) {
    return `${total}s`;
  }

  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

/**
 * The post-turn status line — model, context-window usage, turns, elapsed, last
 * outcome, scope — the at-a-glance summary modern CLIs keep on screen. Dim, one
 * line, printed after a turn settles.
 */
export function renderStatus(
  info: IStatusInfo,
  opts: IRenderOptions = {}
): string {
  const color = opts.color ?? true;
  const pct =
    info.contextWindow > 0
      ? Math.round((info.contextTokens / info.contextWindow) * 100)
      : 0;
  const bits = [
    info.model,
    `ctx ~${humanCount(info.contextTokens)}/${humanCount(info.contextWindow)} ${pct}%`,
  ];

  // Only show turn/elapsed once a turn has actually run (skip the "0 turns · 0s"
  // noise on the very first prompt).
  if (info.turns > 0) {
    bits.push(
      `${info.turns} turn${info.turns === 1 ? "" : "s"}`,
      humanDuration(info.elapsedMs)
    );
  }

  bits.push(info.status, info.scope);

  return `${paint(`  ⎯ ${bits.join(" · ")}`, STYLE.dim, color)}\n`;
}

/**
 * Replay one stored conversation message — used to show the prior transcript on
 * `--continue`. User turns are echoed at the prompt marker, assistant answers
 * get markdown/code highlighting, tool calls collapse to a one-line summary, and
 * the system prompt + raw tool output are omitted (context, not conversation).
 */
export function renderMessage(
  message: IChatMessage,
  opts: IRenderOptions = {}
): string {
  const color = opts.color ?? true;

  if (message.role === "system" || message.role === "tool") {
    return "";
  }

  if (message.role === "user") {
    return `\n${paint("›", STYLE.cyan + STYLE.bold, color)} ${message.content}\n`;
  }

  const parts: string[] = [];

  if (message.content.length > 0) {
    parts.push(renderMarkdown(message.content, color));
  }

  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    const names = message.toolCalls.map((c) => c.name).join(", ");

    parts.push(paint(`  · used ${names}`, STYLE.dim, color));
  }

  return parts.length > 0 ? `\n${parts.join("\n")}\n` : "";
}

function highlightTs(code: string, color: boolean): string {
  return highlightCode(code, "typescript", color);
}

/**
 * Render an assistant message: prose untouched, fenced ```code``` blocks
 * syntax-highlighted (so an inline answer reads as nicely as an `edit`/`create`).
 */
function renderMarkdown(text: string, color: boolean): string {
  if (!color) {
    return text;
  }

  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      const fence = /^```([\w-]*)\n?([\s\S]*?)\n?```$/.exec(part);

      if (fence === null) {
        return part;
      }

      const lang =
        fence[1] !== undefined && fence[1].length > 0 ? fence[1] : "typescript";

      return highlightCode(fence[2] ?? "", lang, color);
    })
    .join("");
}

function highlightCode(code: string, lang: string, color: boolean): string {
  if (!color) {
    return code;
  }

  try {
    return highlight(code, { language: lang, ignoreIllegals: true });
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
/** Latch so a run of `reasoning` tokens collapses to ONE "thinking…" line
 *  instead of streaming the model's full chain-of-thought. Reset by any other
 *  event (a tool marker, gate output, a message), so the next thinking burst
 *  re-announces. The raw reasoning is still written verbatim to the --log. */
let thinkingShown = false;

/** Render a streamed token. Collapses the model's chain-of-thought (channel
 *  `reasoning`) to a single compact "thinking…" line — the prose is noise on
 *  screen (still logged); tool markers (✎) and gate output print normally. */
function renderToken(event: ILoopEvent, color: boolean): string {
  if (event.channel === "reasoning") {
    if (thinkingShown) {
      return "";
    }

    thinkingShown = true;

    return `\n  ${paint("⠋ thinking…", STYLE.dim, color)}`;
  }

  return paint(event.message, STYLE.dim, color);
}

export function renderEvent(
  event: ILoopEvent,
  opts: IRenderOptions = {}
): string {
  const color = opts.color ?? true;

  // Any event that is NOT a reasoning token ends the current thinking burst.
  if (event.kind !== "token" || event.channel !== "reasoning") {
    thinkingShown = false;
  }

  switch (event.kind) {
    case "token":
      return renderToken(event, color);

    case "message":
      // The model's actual answer (content channel) — prose plus syntax-
      // highlighted code blocks, rendered once when the turn settles.
      return event.message.length > 0
        ? `\n${renderMarkdown(event.message, color)}\n`
        : "";

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

    case "usage":
      // Logged for the metrics analyzer, but not shown — the status line already
      // surfaces context usage on screen.
      return "";

    case "tool":
      return `  ${paint(event.message, STYLE.dim, color)}\n`;

    case "timing":
      return `${paint(`  ⏱ ${event.message}`, STYLE.dim, color)}\n`;

    default:
      return `\n${event.message}\n`;
  }
}
