import type { IRenderOptions, IStatusInfo } from "./render.types";
import { highlight } from "cli-highlight";
import type { ILoopEvent } from "../loop";
import type { IChatMessage } from "../inference";
import { STYLE, paint } from "./style";
import { box, table, GLYPH } from "./box";

/** Split highlighted/plain text into the body-line array a box expects. */
function bodyLines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

/** A single glyph-prefixed line — the compact form for events with no body. */
function glyphLine(
  glyph: string,
  text: string,
  accent: string,
  color: boolean
): string {
  return `\n  ${paint(`${glyph} ${text}`, `${accent}${STYLE.bold}`, color)}\n`;
}

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
 * Render an assistant message: fenced ```code``` blocks syntax-highlighted, and
 * GitHub-flavored markdown TABLES drawn as real box tables (the model answers with
 * `| a | b |` tables constantly — raw they're unreadable pipe soup). Other prose
 * passes through.
 */
function renderMarkdown(text: string, color: boolean): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      const fence = /^```([\w-]*)\n?([\s\S]*?)\n?```$/.exec(part);

      if (fence === null) {
        return formatTables(part, color);
      }

      const lang =
        fence[1] !== undefined && fence[1].length > 0 ? fence[1] : "typescript";

      return highlightCode(fence[2] ?? "", lang, color);
    })
    .join("");
}

/** A markdown table separator row, e.g. `|----|:--:|---|`. */
function isTableSeparator(line: string | undefined): boolean {
  return (
    line !== undefined &&
    line.includes("|") &&
    line.includes("-") &&
    /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line)
  );
}

/** Split a `| a | b |` row into trimmed cells (tolerates missing edge pipes). */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Replace each GFM table block in `text` with a box-drawn table; leave the rest. */
function formatTables(text: string, color: boolean): string {
  const lines = text.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; ) {
    const header = lines[i];

    if (
      header !== undefined &&
      header.includes("|") &&
      isTableSeparator(lines[i + 1])
    ) {
      const rows: string[][] = [tableCells(header)];
      let j = i + 2;

      while (j < lines.length && (lines[j]?.includes("|") ?? false)) {
        rows.push(tableCells(lines[j] ?? ""));
        j += 1;
      }

      out.push(table(rows, color));
      i = j;
    } else {
      out.push(header ?? "");
      i += 1;
    }
  }

  return out.join("\n");
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

    return `\n  ${paint("⋯ thinking", STYLE.dim, color)}`;
  }

  return paint(event.message, STYLE.dim, color);
}

/** A shell-command event as a box — exit status drives the accent + glyph (a
 *  non-zero exit goes red ✗); no output → a one-liner. */
function renderRun(event: ILoopEvent, color: boolean): string {
  const ok = event.exitCode === undefined || event.exitCode === 0;
  const title =
    event.exitCode === undefined
      ? event.message
      : `${event.message} (exit ${event.exitCode})`;
  const accent = ok ? STYLE.yellow : STYLE.red;
  const glyph = ok ? GLYPH.run : GLYPH.fail;

  if (event.output === undefined || event.output.length === 0) {
    return glyphLine(glyph, title, accent, color);
  }

  return `\n${box(title, bodyLines(event.output), { glyph, accent, color })}\n`;
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
      // On screen the turn divider is just noise (the status line carries the
      // count); keep a minimal boundary only in the plain log for `tail -f`.
      return color
        ? ""
        : `\n── ${event.message.replace(/:?\s*asking model\s*$/i, "")} ──\n`;

    case "create":
      return event.content === undefined
        ? glyphLine(GLYPH.create, event.message, STYLE.green, color)
        : `\n${box(event.message, bodyLines(highlightTs(event.content, color)), { glyph: GLYPH.create, accent: STYLE.green, color })}\n`;

    case "edit": {
      if (event.oldString === undefined || event.newString === undefined) {
        return glyphLine(GLYPH.edit, event.message, STYLE.cyan, color);
      }

      const body = bodyLines(diff(event.oldString, event.newString, color));

      return `\n${box(event.message, body, { glyph: GLYPH.edit, accent: STYLE.cyan, color })}\n`;
    }

    case "red":
    case "stuck":
      return `\n${paint(`${GLYPH.fail} ${event.message}`, STYLE.red + STYLE.bold, color)}\n`;

    case "validated":
      return event.passed === true
        ? `${paint(`  ${GLYPH.done} ${event.message}`, STYLE.green, color)}\n`
        : `${paint(`  ${GLYPH.bullet} ${event.message}`, STYLE.yellow, color)}\n`;

    case "done":
      return `\n${paint(`${GLYPH.done} ${event.message}`, STYLE.green + STYLE.bold, color)}\n`;

    case "run":
      return renderRun(event, color);

    case "usage":
      // Logged for the metrics analyzer, but not shown — the status line already
      // surfaces context usage on screen.
      return "";

    case "tool":
      return `  ${paint(event.message, STYLE.dim, color)}\n`;

    case "timing":
      // Noise on screen (the status line shows turns + elapsed); log only.
      return color ? "" : `  ${event.message}\n`;

    default:
      return `\n${event.message}\n`;
  }
}
