import type { IRenderOptions, IStatusInfo } from "./render.types";
import type { ILoopEvent } from "../loop";
import {
  isEphemeralUserInject,
  isHarnessUserInject,
} from "../loop/harness-inject";
import type { IChatMessage } from "../inference";
import { RESET, STYLE, paint } from "./style";
import { displayWidth, sliceToWidth } from "./width";
import { box, GLYPH, toolGlyph } from "./box";
import { renderMarkdown, highlightCode } from "./markdown";
import { StreamingMarkdown } from "./stream-markdown";
import { renderDiff } from "./diff";
import { makeAgentRail } from "./agent-rail";
import { stripSgr } from "./frame/ansi-plain";

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

/**
 * Shared role-card geometry — cards share the same right edge (and left rail
 * column for body rows). Badge pills hug their label; hairlines fill the rest.
 */
/** Widest role pill (` AGENT `) — floors minimum card width. */
const ROLE_BADGE_COLS = 7;
/** Spaces after the rail glyph before text (`▌  ` / `│  `) — breathing room. */
const ROLE_INNER_PAD = 2;
/** Open-card left gutter width: glyph + inner pad. */
const ROLE_GUTTER_COLS = 1 + ROLE_INNER_PAD;
/** Closed-card chrome: left glyph+pad + right glyph. */
const ROLE_BOX_CHROME_COLS = ROLE_GUTTER_COLS + 1;
const ROLE_MIN_COLS = ROLE_BADGE_COLS + 2;

/** Role pill body: one space each side — no fixed-width right pad. */
function roleLabel(label: string): string {
  return ` ${label.trim()} `;
}

/** Resolve the shared card width for role chrome. */
export function roleCardCols(columns?: number): number {
  if (columns !== undefined && columns > 0) {
    return Math.max(ROLE_MIN_COLS, columns);
  }

  return Math.max(
    ROLE_MIN_COLS,
    process.stdout.columns > 0 ? process.stdout.columns : 80
  );
}

/**
 * Outlined role badge — accent foreground, no fill (USER cyan / AGENT light
 * zinc / PLAN amber). Same geometry as the old solid pills (` USER ` etc.).
 */
export function filledRoleBadge(
  kind: "USER" | "AGENT" | "PLAN",
  color: boolean
): string {
  const label = roleLabel(kind);

  if (!color) {
    return label;
  }

  if (kind === "USER") {
    return `${STYLE.cyan}${STYLE.bold}${label}${RESET}`;
  }

  if (kind === "AGENT") {
    return `${STYLE.chromeLight}${STYLE.bold}${label}${RESET}`;
  }

  return `${STYLE.plan}${STYLE.bold}${label}${RESET}`;
}

/**
 * Hairline from the badge to the shared right edge.
 * Optional `endCap` (e.g. `┐`) closes an AGENT top rule without changing width.
 * `badgeCols` must match the visible width of the badge that precedes the line
 * so shorter pills (` USER ` / ` PLAN `) still land on the same right edge.
 */
export function roleHairline(
  columns: number,
  code: string,
  color: boolean,
  endCap = "",
  badgeCols: number = ROLE_BADGE_COLS
): string {
  const capCols = endCap.length > 0 ? displayWidth(endCap) : 0;
  const n = Math.max(1, columns - badgeCols - capCols);
  const line = paint("─".repeat(n), code, color);

  return endCap.length > 0 ? `${line}${paint(endCap, code, color)}` : line;
}

/** Visible columns of a filled/plain role badge (ANSI stripped). */
export function roleBadgeCols(badge: string): number {
  return displayWidth(stripSgr(badge));
}

/** Open-card left gutter (`▌  ` / `│  `). */
function roleGutter(glyph: "▌" | "│", code: string, color: boolean): string {
  return paint(glyph, code, color) + " ".repeat(ROLE_INNER_PAD);
}

/** Empty closed USER row — cyan twin of {@link agentCardPadRow}. */
function userCardPadRow(color: boolean, columns: number): string {
  const cols = roleCardCols(columns);
  const inner = Math.max(1, cols - 2);

  // One SGR span for the whole row — a mid-line RESET left the right │ on the
  // default (bright) foreground in iTerm, so empty rows looked speckled.
  return paint(`│${" ".repeat(inner)}│`, STYLE.cyan, color);
}

/**
 * A USER turn: closed cyan card — same geometry as AGENT (`┐` / `│…│` / `└┘`).
 *
 * Wrap plain text first, then paint each closed row as one SGR span. Painting
 * before the rail used to open cyan on the first visual line only: each
 * soft-wrap closes with `paint(│)` which emits RESET, so continuation rows
 * fell back to the default (gray) foreground mid-message.
 */
export function userBubble(
  content: string,
  color: boolean,
  columns: number
): string {
  const cols = roleCardCols(columns);
  const badge = filledRoleBadge("USER", color);
  const top =
    badge + roleHairline(cols, STYLE.cyan, color, "┐", roleBadgeCols(badge));
  // Plain rails while wrapping — color is applied per completed row below.
  const rail = makeAgentRail(
    "│" + " ".repeat(ROLE_INNER_PAD),
    () => Math.max(1, cols - ROLE_BOX_CHROME_COLS),
    "│"
  );
  const wrapped = `${rail.feed(content)}${rail.flush()}`.replace(/\n$/, "");
  const body = wrapped
    .split("\n")
    .map((row) => paint(stripSgr(row), STYLE.cyan + STYLE.bold, color))
    .join("\n");
  const padRow = userCardPadRow(color, cols);
  const bottom = paint(
    `└${"─".repeat(Math.max(0, cols - 2))}┘`,
    STYLE.cyan,
    color
  );

  return [top, padRow, body, padRow, bottom].join("\n");
}

/** One closed agent row: `│  content…  │` padded to `cols`. */
export function agentCardRow(
  content: string,
  color: boolean,
  columns: number
): string {
  const cols = roleCardCols(columns);
  const inner = Math.max(1, cols - 2);

  if (stripSgr(content).length === 0) {
    return paint(`│${" ".repeat(inner)}│`, STYLE.chrome, color);
  }

  const left = paint("│", STYLE.chrome, color);
  const right = paint("│", STYLE.chrome, color);
  const maxText = Math.max(1, inner - ROLE_INNER_PAD * 2);
  const plain = stripSgr(content);
  const text =
    displayWidth(plain) <= maxText
      ? content
      : sliceToWidth(plain, maxText).text;
  const body = `${" ".repeat(ROLE_INNER_PAD)}${text}`;
  const pad = Math.max(ROLE_INNER_PAD, inner - displayWidth(stripSgr(body)));

  return `${left}${body}${" ".repeat(pad)}${right}`;
}

/** Empty closed row — vertical breathing room under the top rule / above the bottom. */
export function agentCardPadRow(color: boolean, columns?: number): string {
  const cols = roleCardCols(columns);
  const inner = Math.max(1, cols - 2);

  return paint(`│${" ".repeat(inner)}│`, STYLE.chrome, color);
}

/** Closed AGENT card top (outlined badge + hairline + `┐`). Model lives in the top bar. */
export function agentCardTop(color: boolean, columns?: number): string {
  const cols = roleCardCols(columns);
  const badge = filledRoleBadge("AGENT", color);

  // No leading `┌` — badge starts on the same column as USER / PLAN.
  return (
    badge + roleHairline(cols, STYLE.chrome, color, "┐", roleBadgeCols(badge))
  );
}

/** Closed AGENT card bottom rule. */
export function agentCardBottom(color: boolean, columns?: number): string {
  const cols = roleCardCols(columns);

  return paint(`└${"─".repeat(Math.max(0, cols - 2))}┘`, STYLE.chrome, color);
}

/** The left-rail prefix (`│  `) painted for every row inside an AGENT card. */
export function agentBar(color: boolean): string {
  return roleGutter("│", STYLE.chrome, color);
}

/** The right-rail closer (`│`) for a closed agent card. */
export function agentRight(color: boolean): string {
  return paint("│", STYLE.chrome, color);
}

/** Content budget inside `│  …  │` (left gutter + right rail). */
export function agentRailInnerCols(columns: number): number {
  return Math.max(20, roleCardCols(columns) - ROLE_BOX_CHROME_COLS);
}

/** Rail-prefix AND soft-wrap a settled agent body (the `--continue` replay
 *  path) with the SAME ANSI-aware, display-width wrapper the live stream uses
 *  (makeAgentRail) — so a long replayed line can never spill past the rail. */
export function agentCardBody(
  text: string,
  color: boolean,
  columns?: number
): string {
  const cols = roleCardCols(columns);
  const rail = makeAgentRail(
    agentBar(color),
    () => agentRailInnerCols(cols),
    agentRight(color)
  );

  // Trim the rail's trailing newline so joiners (`body\n` + pad) cannot inject
  // a railless blank row into scrollback.
  return `${rail.feed(text)}${rail.flush()}`.replace(/\n$/, "");
}

export function renderMessage(
  message: IChatMessage,
  opts: IRenderOptions = {}
): string {
  const color = opts.color ?? true;

  if (message.role === "system" || message.role === "tool") {
    return "";
  }

  // Checklist injects — Tasks rail owns that UI; never a transcript card.
  if (isEphemeralUserInject(message)) {
    return "";
  }

  const columns = opts.columns ?? process.stdout.columns;

  // Human turns only. Harness→model injects are stored as role:user for the
  // API but must paint as AGENT (NEAR-GREEN / gate feedback / resteers).
  if (message.role === "user" && !isHarnessUserInject(message)) {
    return `\n${userBubble(message.content, color, columns)}\n`;
  }

  const parts: string[] = [];

  if (message.content.length > 0) {
    parts.push(renderMarkdown(message.content, color));
  }

  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    const summary = message.toolCalls
      .map((c) => `${toolGlyph(c.name)} ${c.name}`)
      .join("  ");

    parts.push(paint(summary, `${STYLE.brandLight}${STYLE.bold}`, color));
  }

  // Closed card: top + pad, railed body, pad + bottom (model lives in the top bar).
  return parts.length > 0
    ? `\n${agentCardTop(color, columns)}\n` +
        `${agentCardPadRow(color, columns)}\n` +
        `${agentCardBody(parts.join("\n"), color, columns)}\n` +
        `${agentCardPadRow(color, columns)}\n` +
        `${agentCardBottom(color, columns)}\n`
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

  // Live tool-name / path markers (`◎ read…`, `✚ → file`) — bright, not dim.
  return paint(event.message, `${STYLE.brandLight}${STYLE.bold}`, color);
}

/** Leading tool verb in a settled `kind: "tool"` message, if any. */
function toolVerb(message: string): string | undefined {
  const m = /^(read|search|create|edit|run|script)\b/u.exec(message);

  return m?.[1];
}

/**
 * Settled tool lines — same family as create/edit glyphLines (bright accent),
 * not dim grey that vanishes into the pane canvas.
 */
function renderToolEvent(message: string, color: boolean): string {
  if (message.startsWith("⚠") || message.startsWith("△")) {
    return glyphLine(
      GLYPH.warn,
      message.replace(/^[⚠△]\s*/u, ""),
      STYLE.yellow,
      color
    );
  }

  if (message.startsWith("↳")) {
    return glyphLine("↳", message.replace(/^↳\s*/u, ""), STYLE.brand, color);
  }

  const verb = toolVerb(message);

  if (verb !== undefined) {
    return glyphLine(toolGlyph(verb), message, toolAccent(verb), color);
  }

  return glyphLine(GLYPH.info, message, STYLE.chromeLight, color);
}

function toolAccent(verb: string): string {
  if (verb === "create") {
    return STYLE.green;
  }

  if (verb === "run" || verb === "script") {
    return STYLE.yellow;
  }

  return STYLE.brandLight;
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
      return renderToolEvent(event.message, color);

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

    case "ask_user":
      // The co-pilot raised its hand (WS-C): surface the question prominently so the
      // human sees what to answer. `message` is already "ask_user: <question>".
      return `\n${paint(`${GLYPH.bullet} ${event.message}`, STYLE.brand + STYLE.bold, color)}\n`;

    default:
      return `\n${event.message}\n`;
  }
}
