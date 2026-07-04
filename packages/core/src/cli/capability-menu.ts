import { runInlineMenu } from "../render/inline-menu";
import type { IMenuRowData } from "../render/inline-menu";
import type { ICapability } from "./capabilities";
import { buildCapabilities } from "./capabilities";

/**
 * Capability browser menu dependencies.
 * Used to dispatch capability selections to run commands, prefill, or open wizards.
 */
export interface ICapabilityMenuDeps {
  readonly color: boolean;
  readonly hasRecipes: boolean;
  readonly runCommand: (command: string) => void;
  readonly prefill: (command: string) => void;
  readonly openWizard: (opener: "scaffold" | "recipe") => Promise<void>;
  readonly render: (lines: readonly string[]) => void;
  readonly close: () => void;
}

/**
 * Convert capabilities to inline menu rows.
 * Each row shows the capability's label, describe, and a hint (slash command or wizard tag).
 */
export function capabilityRows(caps: readonly ICapability[]): IMenuRowData[] {
  return caps.map((cap) => {
    let hint = "";

    if (cap.kind === "command") {
      const invoke = cap.invoke;

      if (invoke?.type === "run" || invoke?.type === "prefill") {
        hint = invoke.command;
      }
    } else {
      const invoke = cap.invoke;

      if (invoke?.type === "wizard") {
        hint = invoke.opener;
      }
    }

    return {
      id: cap.id,
      label: cap.label,
      hint,
      describe: cap.describe,
    };
  });
}

/**
 * Run the capability browser menu via inline dropdown.
 * Displays all capabilities, allows navigation and selection.
 * - command (run) → runCommand, close
 * - command (prefill) → prefill, close
 * - wizard → openWizard, close
 */
export function runCapabilityMenu(deps: ICapabilityMenuDeps): Promise<void> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    return Promise.resolve();
  }

  const capabilities = buildCapabilities({ hasRecipes: deps.hasRecipes });
  const rows = capabilityRows(capabilities);

  return runInlineMenu(rows, {
    render: deps.render,
    close: deps.close,
  }).then((selected) => {
    if (selected === null) {
      return Promise.resolve();
    }

    const cap = capabilities[selected];

    if (cap === undefined) {
      return Promise.resolve();
    }

    if (cap.kind === "command") {
      const invoke = cap.invoke;

      if (invoke?.type === "run") {
        deps.runCommand(invoke.command);
      } else if (invoke?.type === "prefill") {
        deps.prefill(invoke.command);
      }

      return Promise.resolve();
    }

    const invoke = cap.invoke;

    if (invoke?.type === "wizard") {
      return Promise.resolve(deps.openWizard(invoke.opener)).catch(() => {
        // ignore
      });
    }

    return Promise.resolve();
  });
}
