import { emitKeypressEvents } from "node:readline";
import type { IMenuRow } from "../render/owned-menu";
import { renderMenu } from "../render/owned-menu";
import type { ICapability } from "./capabilities";
import { buildCapabilities } from "./capabilities";
import { clampIndex } from "../render/command-menu";

/**
 * Capability browser menu dependencies.
 * Used to dispatch capability selections and manage the editor suspend/resume lifecycle.
 */
export interface ICapabilityMenuDeps {
  readonly color: boolean;
  readonly hasRecipes: boolean;
  readonly suspend: () => void;
  readonly resume: () => void;
  readonly runCommand: (command: string) => void;
  readonly prefill: (command: string) => void;
  readonly openWizard: (opener: "scaffold" | "recipe") => Promise<void>;
  readonly showDetail: (cap: ICapability) => Promise<void>;
}

/**
 * Convert capabilities to menu rows.
 * Each row shows the capability's group, label, and description.
 */
export function capabilityRows(caps: readonly ICapability[]): IMenuRow[] {
  return caps.map((cap) => ({
    group: cap.group,
    label: cap.label,
    describe: cap.describe,
  }));
}

/**
 * Run the capability browser menu.
 * Displays all capabilities grouped, allows navigation and selection.
 * - command (run) → runCommand, close
 * - command (prefill) → prefill, close
 * - wizard → openWizard, close
 * - passive → showDetail, stay in menu
 */
export function runCapabilityMenu(deps: ICapabilityMenuDeps): Promise<void> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const capabilities = buildCapabilities({ hasRecipes: deps.hasRecipes });
    const rows = capabilityRows(capabilities);
    let cursor = 0;

    deps.suspend();
    emitKeypressEvents(stdin);

    const saved = stdin.rawListeners("keypress");

    stdin.removeAllListeners("keypress");

    const ESC = String.fromCharCode(27);
    const ENTER_ALT = `${ESC}[?1049h${ESC}[r`;
    const EXIT_ALT = `${ESC}[?1049l`;
    const HIDE_CURSOR = `${ESC}[?25l`;
    const SHOW_CURSOR = `${ESC}[?25h`;
    const CLEAR_HOME = `${ESC}[2J${ESC}[H`;

    const out = (s: string): void => {
      process.stdout.write(s);
    };

    const draw = (): void => {
      out(`${CLEAR_HOME}${renderMenu(rows, cursor, deps.color)}`);
    };

    const finish = (): void => {
      stdin.removeListener("keypress", onKey);

      try {
        out(`${SHOW_CURSOR}${EXIT_ALT}`);
      } catch {
        // stream closed
      }

      for (const l of saved) {
        stdin.on("keypress", (...args: unknown[]) => {
          Reflect.apply(l, stdin, args);
        });
      }

      deps.resume();
      resolve();
    };

    const handleSelection = (): void => {
      if (cursor >= capabilities.length) {
        return;
      }

      const cap = capabilities[cursor];

      if (cap === undefined) {
        return;
      }

      if (cap.kind === "passive") {
        // Show detail and stay in menu
        void deps
          .showDetail(cap)
          .then(() => {
            draw();
          })
          .catch(() => {
            draw();
          });
      } else if (cap.kind === "command") {
        // Handle command invocation
        const invoke = cap.invoke;

        if (invoke?.type === "run") {
          deps.runCommand(invoke.command);
        } else if (invoke?.type === "prefill") {
          deps.prefill(invoke.command);
        }

        finish();
      } else {
        // Open wizard and close
        const invoke = cap.invoke;

        if (invoke?.type !== "wizard") {
          return;
        }

        void deps
          .openWizard(invoke.opener)
          .then(() => {
            finish();
          })
          .catch(() => {
            finish();
          });
      }
    };

    interface IKeyInfo {
      readonly name?: string;
      readonly ctrl?: boolean;
    }

    const onKey = (_str: string | undefined, key: IKeyInfo): void => {
      try {
        if ((key.ctrl === true && key.name === "c") || key.name === "escape") {
          finish();

          return;
        }

        if (key.name === "up") {
          cursor = clampIndex(cursor - 1, rows.length);
          draw();
        } else if (key.name === "down") {
          cursor = clampIndex(cursor + 1, rows.length);
          draw();
        } else if (key.name === "return") {
          handleSelection();
        }
      } catch {
        finish();
      }
    };

    stdin.on("keypress", onKey);
    out(`${ENTER_ALT}${HIDE_CURSOR}`);
    draw();
  });
}
