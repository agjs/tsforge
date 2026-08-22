import type {
  IResolvedTuiKeybindings,
  TuiPaneAction,
} from "../config/tui-keybindings";
import { TUI_PANE_ACTIONS } from "../config/tui-keybindings";
import { formatOverlayShell } from "./menu-chrome";

const ACTION_LABELS: Readonly<Record<TuiPaneAction, string>> = {
  "pane.toggle": "Toggle right rail",
  "pane.cycleSurface": "Cycle Tasks / Gate",
  "pane.focus": "Focus rail",
  "pane.unfocus": "Return to prompt",
  "pane.moveUp": "Move selection up",
  "pane.moveDown": "Move selection down",
  "keymap.show": "Show keymap",
};

function formatChordList(chords: readonly string[]): string {
  return chords.join(" · ");
}

/** Build overlay rows for the idle `?` keymap (effective configured bindings). */
export function formatKeymapOverlay(
  bindings: IResolvedTuiKeybindings,
  columns: number,
  color = true
): readonly string[] {
  const body: string[] = [
    "Pane",
    ...TUI_PANE_ACTIONS.filter((a) => a !== "keymap.show").map((action) => {
      const chords = bindings.display[action];
      const label = ACTION_LABELS[action];

      return `  ${label.padEnd(22)} ${formatChordList(chords)}`;
    }),
    "",
    "Editor (fixed this release)",
    "  Shift+Enter          newline",
    "  Shift+Tab            cycle mode",
    "  @                    file / symbol picker",
    "  /                    command palette",
    "",
    "Overlay",
    `  ${ACTION_LABELS["keymap.show"].padEnd(22)} ${formatChordList(bindings.display["keymap.show"])}`,
    "  Esc                  close",
  ];

  return formatOverlayShell({
    title: "Keymap",
    bodyLines: body,
    footer: "Esc close",
    columns,
    color,
  });
}
