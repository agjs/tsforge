import { basename } from "node:path";
import { CONSOLE } from "../render/frame/chrome";
import { STYLE, paint } from "../render/style";

export interface IScaffoldHandoff {
  readonly dir: string;
  readonly sha: string;
  readonly booted: boolean;
  readonly bootError?: string;
  readonly summary: readonly string[];
  readonly archetype: string;
  /** REPL: next prompt plans. CLI: show how to launch tsforge. */
  readonly interactive: boolean;
}

function kindLabel(archetype: string): string {
  if (archetype === "phaser") {
    return "Phaser game";
  }

  if (archetype === "astro") {
    return "Astro site";
  }

  return "Boringstack app";
}

/**
 * Closed, colored ready block — not a dump of absolute paths, empty .env,
 * or `booted false`. Basename only; env/boot lines only when they exist.
 */
export function formatScaffoldHandoff(
  h: IScaffoldHandoff,
  color: boolean
): string {
  const name = basename(h.dir);
  const kind = kindLabel(h.archetype);
  const sha = h.sha.slice(0, 7);
  const lines: string[] = [
    "",
    paint(" READY", STYLE.green + STYLE.bold, color),
  ];

  lines.push("");
  lines.push(`  ${paint(name, STYLE.bold, color)}`);
  lines.push(
    `  ${paint(kind, CONSOLE.soft, color)}${sha.length > 0 ? paint(` · ${sha}`, CONSOLE.muted, color) : ""}`
  );

  if (h.booted) {
    lines.push(`  ${paint("stack booted", STYLE.green, color)}`);
  } else if (h.bootError !== undefined && h.bootError.length > 0) {
    lines.push(`  ${paint(`boot: ${h.bootError}`, STYLE.yellow, color)}`);
  }

  if (h.summary.length > 0) {
    lines.push("");

    for (const row of h.summary) {
      lines.push(`  ${paint(row, CONSOLE.fg, color)}`);
    }
  }

  lines.push("");
  lines.push(
    `  ${paint(
      h.interactive
        ? "describe the product to plan it"
        : `tsforge --dir ${name}`,
      CONSOLE.fg,
      color
    )}`
  );
  lines.push("");

  return `${lines.join("\n")}\n`;
}
