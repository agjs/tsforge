import { STYLE, paint } from "./style";

/**
 * Welcome banner for the interactive CLI — solid forge emblem, wordmark,
 * model/endpoint. Centering uses visible (un-painted) length.
 */
export interface IBannerInfo {
  model: string;
  endpoint: string;
  color?: boolean;
}

/** Chars between the two vertical borders. */
const INNER = 58;

interface ISegment {
  text: string;
  code?: string;
}

interface ILine {
  text?: string;
  code?: string;
  segments?: readonly ISegment[];
}

const BLANK: ILine = { text: "" };

/** Compact solid anvil — filled blocks, horn + face + base (~9 cols). */
const EMBLEM: readonly ILine[] = [
  { text: "· ✦ ✦ ·", code: STYLE.brandLight },
  { text: "▄▀▀▀▄", code: STYLE.brandLight + STYLE.bold },
  { text: "███████", code: STYLE.brand + STYLE.bold },
  { text: "▀▀▀▀▀▀▀▀▀", code: STYLE.brandDark + STYLE.bold },
];

/** Split wordmark under the emblem. */
const WORDMARK: ILine = {
  segments: [
    { text: "ts", code: STYLE.brandLight + STYLE.bold },
    { text: "forge", code: STYLE.brand + STYLE.bold },
  ],
};

export function welcomeBanner(info: IBannerInfo): string {
  const color = info.color ?? true;

  const lines: ILine[] = [
    BLANK,
    ...EMBLEM,
    BLANK,
    WORDMARK,
    BLANK,
    { text: "strict TypeScript, gate-driven", code: STYLE.dim },
    BLANK,
    { text: info.model, code: STYLE.brand + STYLE.bold },
    { text: info.endpoint, code: STYLE.dim },
    BLANK,
  ];

  const body = lines.map((line) => boxLine(line, color)).join("\n");

  return `${topBorder(color)}\n${body}\n${bottomBorder()}\n`;
}

function topBorder(color: boolean): string {
  const label = "─── tsforge ";
  const fill = "─".repeat(Math.max(0, INNER - label.length));
  const frame = `╭${label}${fill}╮`;

  return color
    ? paint("╭", STYLE.dim, color) +
        paint(label, STYLE.brandDark, color) +
        paint(fill + "╮", STYLE.dim, color)
    : frame;
}

function bottomBorder(): string {
  return `╰${"─".repeat(INNER)}╯`;
}

function visibleText(line: ILine): string {
  if (line.segments !== undefined) {
    return line.segments.map((s) => s.text).join("");
  }

  return line.text ?? "";
}

function renderContent(line: ILine, color: boolean): string {
  if (line.segments !== undefined) {
    return line.segments
      .map((s) =>
        s.code === undefined ? s.text : paint(s.text, s.code, color)
      )
      .join("");
  }

  const text = line.text ?? "";

  return line.code === undefined ? text : paint(text, line.code, color);
}

/** Center `line` within INNER and frame it with the vertical borders. */
function boxLine(line: ILine, color: boolean): string {
  const visible = visibleText(line);
  const pad = Math.max(0, INNER - visible.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  const content = renderContent(line, color);

  return `│${" ".repeat(left)}${content}${" ".repeat(right)}│`;
}
