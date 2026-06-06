import { STYLE, paint } from "./style";

/**
 * The nerdy welcome banner shown when the interactive CLI starts — a boxed
 * tsforge forge emblem with the active model + endpoint, in the spirit of other
 * agentic CLIs. Pure string-building; centering is computed from the VISIBLE
 * (un-painted) length so ANSI codes never throw off the box alignment.
 */
export interface IBannerInfo {
  model: string;
  endpoint: string;
  color?: boolean;
}

/** Chars between the two vertical borders. */
const INNER = 58;

interface ILine {
  /** The visible text (used for centering). */
  text: string;
  /** Optional ANSI code to paint it with. */
  code?: string;
}

/** A stylized anvil under a shower of sparks — strict TypeScript, forged. */
const EMBLEM: ILine[] = [
  { text: "·   ✦    ✦   ·", code: STYLE.yellow },
  { text: "▗▄▄██████████▄▄▖", code: STYLE.orange + STYLE.bold },
  { text: "▝▀▀▀▀██████▀▀▀▀▘", code: STYLE.orange },
  { text: "▗▟████████████▙▖", code: STYLE.cyan + STYLE.bold },
  { text: "▝▀▀▀▀▀▀▀▀▀▀▀▀▀▀▘", code: STYLE.cyan },
];

const BLANK: ILine = { text: "" };

export function welcomeBanner(info: IBannerInfo): string {
  const color = info.color ?? true;

  const lines: ILine[] = [
    BLANK,
    { text: "Welcome to the forge", code: STYLE.bold },
    BLANK,
    ...EMBLEM,
    BLANK,
    { text: "strict TypeScript, forged green", code: STYLE.dim },
    BLANK,
    { text: info.model, code: STYLE.cyan + STYLE.bold },
    { text: info.endpoint, code: STYLE.dim },
    BLANK,
  ];

  const body = lines.map((line) => boxLine(line, color)).join("\n");

  return `${topBorder()}\n${body}\n${bottomBorder()}\n`;
}

function topBorder(): string {
  const label = "─── tsforge ";
  const fill = "─".repeat(Math.max(0, INNER - label.length));

  return `╭${label}${fill}╮`;
}

function bottomBorder(): string {
  return `╰${"─".repeat(INNER)}╯`;
}

/** Center `line` within INNER and frame it with the vertical borders. */
function boxLine(line: ILine, color: boolean): string {
  const pad = Math.max(0, INNER - line.text.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  const content =
    line.code === undefined ? line.text : paint(line.text, line.code, color);

  return `│${" ".repeat(left)}${content}${" ".repeat(right)}│`;
}
