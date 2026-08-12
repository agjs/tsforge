/**
 * Panel visibility/focus state machine.
 *
 * Ctrl+G toggles hide ↔ show. Tab/Esc move focus when the rail is visible.
 * userCollapsed keeps a user hide sticky across soft panel refreshes.
 */

export type PanelVis = "hidden" | "visibleUnfocused" | "visibleFocused";
export type ActiveSurface = "prompt" | "scrollback" | "panel";

export type FocusAction = "changed" | "ignored";

export class PaneFocus {
  panel: PanelVis = "hidden";
  active: ActiveSurface = "prompt";
  /** Selected row index within the worklist body (0 = first item; title is sticky). */
  selection = 0;
  /** User hid the rail via Ctrl+G — syncHasItems must not force it back open. */
  userCollapsed = false;

  get promptFocused(): boolean {
    return this.active === "prompt";
  }

  get panelFocused(): boolean {
    return this.panel === "visibleFocused" && this.active === "panel";
  }

  /** Sync visibility when worklist content appears/disappears. */
  syncHasItems(hasItems: boolean): void {
    if (hasItems && this.panel === "hidden" && !this.userCollapsed) {
      this.panel = "visibleUnfocused";
    }

    if (!hasItems && this.panel !== "hidden") {
      this.panel = "hidden";

      if (this.active === "panel") {
        this.active = "prompt";
      }
    }

    // userCollapsed is NOT cleared here. Content sync runs on every panel
    // repaint (spinner ticks included), so clearing it would un-hide the rail
    // within a frame of the user pressing Ctrl+G. Only Ctrl+G clears it.
  }

  focusPrompt(): FocusAction {
    if (this.active === "prompt" && this.panel !== "visibleFocused") {
      return "ignored";
    }

    if (this.panel === "visibleFocused") {
      this.panel = "visibleUnfocused";
    }

    this.active = "prompt";

    return "changed";
  }

  focusScrollback(): FocusAction {
    this.active = "scrollback";

    if (this.panel === "visibleFocused") {
      this.panel = "visibleUnfocused";
    }

    return "changed";
  }

  /**
   * Ctrl+G: hide ↔ show the Tasks rail. Showing with items focuses the panel
   * (Esc returns to the prompt). Hiding sets userCollapsed so soft checklist
   * refreshes cannot force the rail back open.
   */
  togglePanel(hasItems: boolean): FocusAction {
    if (!this.userCollapsed) {
      this.userCollapsed = true;
      this.panel = "hidden";
      this.active = "prompt";

      return "changed";
    }

    this.userCollapsed = false;

    if (hasItems) {
      this.panel = "visibleFocused";
      this.active = "panel";
    } else {
      this.panel = "visibleUnfocused";
      this.active = "prompt";
    }

    return "changed";
  }

  /** Esc: panel → prompt; scrollback → prompt. */
  escape(): FocusAction {
    if (this.active === "panel" || this.panel === "visibleFocused") {
      this.panel = this.panel === "hidden" ? "hidden" : "visibleUnfocused";
      this.active = "prompt";

      return "changed";
    }

    if (this.active === "scrollback") {
      this.active = "prompt";

      return "changed";
    }

    return "ignored";
  }

  /** Tab: panel → prompt; prompt + visible panel → panel. */
  tab(hasItems: boolean): FocusAction {
    if (this.userCollapsed || this.panel === "hidden") {
      return "ignored";
    }

    if (this.active === "panel") {
      return this.focusPrompt();
    }

    if (this.active === "prompt" && hasItems) {
      this.panel = "visibleFocused";
      this.active = "panel";

      return "changed";
    }

    return "ignored";
  }

  moveSelection(delta: number, maxIndex: number): FocusAction {
    if (!this.panelFocused || maxIndex < 0) {
      return "ignored";
    }

    const next = Math.max(0, Math.min(maxIndex, this.selection + delta));

    if (next === this.selection) {
      return "ignored";
    }

    this.selection = next;

    return "changed";
  }
}
