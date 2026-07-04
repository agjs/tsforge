import type { IRenderOptions, IStatusInfo } from "./render.types";
import type { ILoopEvent } from "../loop";
import type { IChatMessage } from "../inference";
import { STYLE, paint } from "./style";
import { displayWidth, padToWidth, sliceToWidth } from "./width";
import { box, GLYPH } from "./box";
import { renderMarkdown, highlightCode } from "./markdown";
import { StreamingMarkdown } from "./stream-markdown";
import { renderDiff } from "./diff";

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
 * The status segments — model, context-window usage, turns, elapsed, tok/s, last
 * outcome, scope — as a plain-text list. Shared by the inline `renderStatus`
 * fallback and the pinned `StatusBar`, so both show identical content.
 */
export function statusSegments(info: IStatusInfo): string[] {
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

  if (info.tokensPerSecond !== undefined && info.tokensPerSecond > 0) {
    bits.push(`${info.tokensPerSecond} tok/s`);
  }

  if (info.mode !== undefined && info.mode.length > 0) {
    bits.push(`◆ ${info.mode}`);
  }

  bits.push(info.status, info.scope);

  return bits;
}

/**
 * The post-turn status line — the inline fallback used when a pinned status bar
 * can't be installed (non-TTY, piped, `--log`, tiny terminal). Dim, one line.
 */
export function renderStatus(
  info: IStatusInfo,
  opts: IRenderOptions = {}
): string {
  const color = opts.color ?? true;
  const bits = statusSegments(info);

  return `${paint(`  ⎯ ${bits.join(" · ")}`, STYLE.dim, color)}\n`;
}

/**
 * Replay one stored conversation message — used to show the prior transcript on
 * `--continue`. User turns are echoed at the prompt marker, assistant answers
 * get markdown/code highlighting, tool calls collapse to a one-line summary, and
 * the system prompt + raw tool output are omitted (context, not conversation).
 */
/** Indent under a speaker label so each turn reads as its own block. */
export const BLOCK_INDENT = "    ";

/** Indent every non-empty line of a block (blank lines stay blank — no trailing
 *  whitespace). Used to inset a message body under its `▌ speaker` label. */
export function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? BLOCK_INDENT + line : line))
    .join("\n");
}

/** A `▌ name` speaker label — brand+bold for you, dim for the agent. */
export function speakerLabel(
  name: string,
  accent: boolean,
  color: boolean
): string {
  return paint(
    `▌ ${name}`,
    accent ? STYLE.brand + STYLE.bold : STYLE.dim,
    color
  );
}

/** Word-wrap `text` to `width` display columns; a word wider than the line is
 *  hard-broken so no output row ever overflows. */
export function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }

  const out: string[] = [];

  for (const rawLine of text.split("\n")) {
    let cur = "";

    for (const word of rawLine.split(" ")) {
      const candidate = cur.length === 0 ? word : `${cur} ${word}`;

      if (displayWidth(candidate) <= width) {
        cur = candidate;
        continue;
      }

      if (cur.length > 0) {
        out.push(cur);
      }

      let rest = word;

      while (displayWidth(rest) > width) {
        const head = sliceToWidth(rest, width);

        out.push(head.text);
        rest = rest.slice(head.text.length);
      }

      cur = rest;
    }

    out.push(cur);
  }

  return out;
}

/** A full rounded bubble for a USER message: `╭─ you ─╮ / │ … │ / ╰──╯`, sized to
 *  its content and capped at the terminal width, painted brand. */
export function userBubble(
  content: string,
  color: boolean,
  columns: number
): string {
  const label = "you";
  const maxInner = Math.max(label.length + 4, columns - 2);
  const body = wrapToWidth(content, Math.max(1, maxInner - 2));
  const widest = body.reduce((m, l) => Math.max(m, displayWidth(l)), 0);
  const inner = Math.min(maxInner, Math.max(label.length + 4, widest + 2));
  const fill = "─".repeat(Math.max(0, inner - label.length - 3));
  const top = paint(`╭─ ${label} ${fill}╮`, STYLE.brand + STYLE.bold, color);
  const bottom = paint(`╰${"─".repeat(inner)}╯`, STYLE.brand, color);
  const side = paint("│", STYLE.brand, color);
  const rows = body.map(
    (line) =>
      `${side} ${paint(padToWidth(line, inner - 2), STYLE.brand + STYLE.bold, color)} ${side}`
  );

  return [top, ...rows, bottom].join("\n");
}

/** The rounded top cap + model label for an AGENT card (streams below it). */
export function agentCardTop(model: string, color: boolean): string {
  return paint(`╭ ${model}`, STYLE.brandLight + STYLE.bold, color);
}

/** The rounded bottom cap that closes an AGENT card. */
export function agentCardBottom(color: boolean): string {
  return paint("╰", STYLE.brandLight, color);
}

/** The left-rail prefix (`│ `) painted for every row inside an AGENT card. */
export function agentBar(color: boolean): string {
  return `${paint("│", STYLE.brandLight, color)} `;
}

/** Prefix each line of a settled agent body with the card's left rail. */
export function agentCardBody(text: string, color: boolean): string {
  const bar = agentBar(color);

  return text
    .split("\n")
    .map((line) => `${bar}${line}`)
    .join("\n");
}

export function renderMessage(
  message: IChatMessage,
  opts: IRenderOptions = {}
): string {
  const color = opts.color ?? true;

  if (message.role === "system" || message.role === "tool") {
    return "";
  }

  if (message.role === "user") {
    // A full rounded bubble so YOUR turns read as a distinct block.
    const columns = opts.columns ?? process.stdout.columns;

    return `\n${userBubble(message.content, color, columns)}\n`;
  }

  const parts: string[] = [];

  if (message.content.length > 0) {
    parts.push(renderMarkdown(message.content, color));
  }

  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    const names = message.toolCalls.map((c) => c.name).join(", ");

    parts.push(paint(`· used ${names}`, STYLE.dim, color));
  }

  // A left-accent card (rounded caps + rail), streaming-friendly.
  return parts.length > 0
    ? `\n${agentCardTop(opts.speaker ?? "assistant", color)}\n` +
        `${agentCardBody(parts.join("\n"), color)}\n` +
        `${agentCardBottom(color)}\n`
    : "";
}

function highlightTs(code: string, color: boolean): string {
  return highlightCode(code, "typescript", color);
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

/** Live answer stream — content tokens render incrementally through this; the
 *  settled `message` event then skips its duplicate full render (sawContent). */
const stream = new StreamingMarkdown();

/** Render a streamed token. The answer (channel `content`) streams live through
 *  the incremental markdown renderer; the chain-of-thought (`reasoning`)
 *  collapses to a compact indicator (on a TTY the CLI spinner owns it); tool
 *  markers (✎) and gate output print normally. */
function renderToken(event: ILoopEvent, color: boolean): string {
  if (event.channel === "reasoning") {
    // On a live TTY the CLI's animated spinner is the thinking indicator; the
    // static one-time line is for piped color output and plain logs.
    if (color && process.stdout.isTTY) {
      return "";
    }

    if (thinkingShown) {
      return "";
    }

    thinkingShown = true;

    return `\n  ${paint("⋯ thinking", STYLE.dim, color)}`;
  }

  if (event.channel === "content") {
    // Plain/log mode stays quiet here — the consolidated `message` event is
    // the log's record, so agent.log keeps its exact pre-streaming shape.
    return color ? stream.push(event.message, true) : "";
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

  // Any event that is NOT a content token first flushes the live answer stream
  // (the closing table/fence, or a partial line on abort) so nothing is lost.
  const isContentToken = event.kind === "token" && event.channel === "content";
  const pending = color && !isContentToken ? stream.flush(true) : "";

  return pending + renderEventBody(event, color);
}

function renderEventBody(event: ILoopEvent, color: boolean): string {
  switch (event.kind) {
    case "token":
      return renderToken(event, color);

    case "message":
      // The model's actual answer. When it already streamed live (content
      // tokens), emit just a closing separator — the text is on screen; the
      // full render here would print it twice. Without streamed content
      // (non-streaming provider, replayed events, plain logs) render in full.
      if (color && stream.sawContent) {
        stream.reset();

        return "\n";
      }

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
        return glyphLine(GLYPH.edit, event.message, STYLE.brand, color);
      }

      const body = bodyLines(
        renderDiff(event.oldString, event.newString, { color })
      );

      return `\n${box(event.message, body, { glyph: GLYPH.edit, accent: STYLE.brand, color })}\n`;
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

    case "reverted":
      // Accounting-only (feeds accept-rate); the human-facing "reverted" message
      // rides the paired `fix` event, so this would only double-print.
      return "";

    case "policy":
      // Ledger-only signal; a denial is already shown via its `tool` event.
      return "";

    case "timing":
      // Noise on screen (the status line shows turns + elapsed); log only.
      return color ? "" : `  ${event.message}\n`;

    default:
      return `\n${event.message}\n`;
  }
}
