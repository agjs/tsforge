/** The CLI's landing surface: welcome banner, the compact startup hint line,
 *  the plan-mode footer chip, and the resumed-transcript replay. */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { renderMessage, welcomeBanner, STYLE, paint } from "../render";
import type { ISessionRecord } from "../session-store";

/** Human label for an editable scope (the whole-repo default reads nicer). */
export function scopeLabel(files: string[]): string {
  return files.length === 1 && files[0] === "**/*"
    ? "entire workspace"
    : files.join(", ");
}

/** A single compact "how to start" line under the banner — the only guidance the
 *  landing screen needs. The internals (cwd, scope, gate, session) live in /config. */
function startupHint(): string {
  const tip = (key: string, label: string): string =>
    `${paint(key, STYLE.brand + STYLE.bold, true)} ${paint(label, STYLE.dim, true)}`;
  const sep = paint("   ·   ", STYLE.dim, true);

  return `  ${[
    tip("/help", "commands"),
    tip("@", "files"),
    tip("/setup", "guardrails"),
    tip("/exit", "quit"),
  ].join(sep)}`;
}

/** The post-turn plan-mode footer — a compact styled chip (matches the startup
 *  plan line) instead of a plain full-width parenthetical. `ready` = the agent has
 *  proposed a plan (nudge toward approve); otherwise it's still exploring. */
export function planHint(ready: boolean): string {
  const chip = paint(
    `◆ plan${ready ? " ready" : ""}`,
    STYLE.brand + STYLE.bold,
    true
  );
  const reply = paint("reply to refine · type", STYLE.dim, true);
  const approve = paint("approve", STYLE.green + STYLE.bold, true);
  const tail = paint(ready ? "to build" : "when ready", STYLE.dim, true);

  return `  ${chip}  ${paint("·", STYLE.dim, true)}  ${reply} ${approve} ${tail}`;
}

/** Print the welcome banner, a compact hint, and (when resuming) the prior transcript. */
export function printHeader(info: {
  dir: string;
  id: string;
  gateLabel: string;
  files: string[];
  resumed: ISessionRecord | null;
  model: { model: string; endpoint: string };
  updateNotice?: string | null;
}): void {
  const { resumed, model, updateNotice } = info;

  if (process.stdout.isTTY) {
    // Clean slate: wipe the visible screen AND scrollback so the banner never
    // lands on top of leftover shell output (env dumps, prior command noise).
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  }

  process.stdout.write(welcomeBanner(model));

  if (updateNotice !== undefined && updateNotice !== null) {
    process.stdout.write(`${updateNotice}\n`);
  }

  process.stdout.write(`${startupHint()}\n\n`);

  if (resumed === null) {
    return;
  }

  // Replay the prior conversation so a resumed session has visible context.
  process.stdout.write("\n── resuming conversation ──\n");

  for (const message of resumed.messages) {
    process.stdout.write(
      renderMessage(message, { color: true, speaker: model.model })
    );
  }

  process.stdout.write("\n──────────────────────────\n");
}

/** One-line nudge when the repo has no config yet — setup adapts the guardrails
 *  to this repo's conventions. Just a hint; never auto-runs. */
export function maybePrintNoConfigHint(
  dir: string,
  resumed: ISessionRecord | null
): void {
  if (resumed === null && !existsSync(join(dir, "tsforge.config.json"))) {
    const icon = paint("○", STYLE.yellow, true);
    const run = paint("/setup", STYLE.brand + STYLE.bold, true);
    const rest = paint("to adapt the guardrails to this repo", STYLE.dim, true);

    process.stdout.write(`  ${icon} no project config — run ${run} ${rest}\n`);
  }
}
