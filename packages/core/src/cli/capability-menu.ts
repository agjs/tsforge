import { runOwnedMenu } from "../render/owned-menu";
import type {
  IMenuRow,
  IOwnedMenuDeps,
  IOwnedMenuSelectControl,
} from "../render/owned-menu";
import type { ICapability } from "./capabilities";
import { buildCapabilities } from "./capabilities";

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

  const capabilities = buildCapabilities({ hasRecipes: deps.hasRecipes });

  const menuRows = (): readonly IMenuRow[] => capabilityRows(capabilities);

  const onSelect = async (
    index: number,
    control: IOwnedMenuSelectControl
  ): Promise<void> => {
    const cap = capabilities[index];

    if (cap === undefined) {
      return;
    }

    if (cap.kind === "passive") {
      // Show detail and stay in menu
      control.pause();

      await Promise.resolve(deps.showDetail(cap))
        .catch(() => {
          // ignore
        })
        .finally(() => {
          control.resume();
        });
    } else if (cap.kind === "command") {
      // Handle command invocation
      const invoke = cap.invoke;

      if (invoke?.type === "run") {
        deps.runCommand(invoke.command);
      } else if (invoke?.type === "prefill") {
        deps.prefill(invoke.command);
      }

      control.close();
    } else {
      // Open wizard and close
      const invoke = cap.invoke;

      if (invoke?.type !== "wizard") {
        return;
      }

      await Promise.resolve(deps.openWizard(invoke.opener)).catch(() => {
        // ignore
      });
      control.close();
    }
  };

  const ownedMenuDeps: IOwnedMenuDeps = {
    color: deps.color,
    title: "tsforge — what can I do?",
    subtitle: "Commands · Tools · Wizards",
    footer: "↑/↓ move   enter select   esc done",
    suspend: deps.suspend,
    resume: deps.resume,
    rows: menuRows,
    onSelect,
  };

  return runOwnedMenu(ownedMenuDeps);
}
