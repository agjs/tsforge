/**
 * Panel visibility/focus state machine (Grok OverlayState, no fullscreen).
 *
 *   hidden ──toggle──► visibleFocused ──toggle──► visibleUnfocused
 *                         ▲ Esc/Tab                    │ toggle
 *                         └──────── prompt ◄───────────┘
 */

export type PanelVis = "hidden" | "visibleUnfocused" | "visibleFocused";
export type ActiveSurface = "prompt" | "scrollback" | "panel";

export type FocusAction = "changed" | "ignored";

export class PaneFocus {
  panel: PanelVis = "hidden";
  active: ActiveSurface = "prompt";
  /** Selected row index within the worklist body (0 = first item; title is sticky). */
  selection = 0;

  get promptFocused(): boolean {
    return this.active === "prompt";
  }

  get panelFocused(): boolean {
    return this.panel === "visibleFocused" && this.active === "panel";
  }

  /** Sync visibility when worklist content appears/disappears. */
  syncHasItems(hasItems: boolean): void {
    if (hasItems && this.panel === "hidden") {
      this.panel = "visibleUnfocused";
    }

    if (!hasItems && this.panel !== "hidden") {
      this.panel = "hidden";

      if (this.active === "panel") {
        this.active = "prompt";
      }
    }
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
   * Ctrl+G: with items, cycle unfocused ↔ focused; without items, toggle hidden.
   * Focusing the panel also sets active = panel.
   */
  togglePanel(hasItems: boolean): FocusAction {
    if (!hasItems) {
      if (this.panel === "hidden") {
        this.panel = "visibleUnfocused";
        this.active = "prompt";

        return "changed";
      }

      this.panel = "hidden";
      this.active = "prompt";

      return "changed";
    }

    if (this.panel === "hidden") {
      this.panel = "visibleFocused";
      this.active = "panel";

      return "changed";
    }

    if (this.panel === "visibleUnfocused") {
      this.panel = "visibleFocused";
      this.active = "panel";

      return "changed";
    }

    // visibleFocused → unfocused, return to prompt
    this.panel = "visibleUnfocused";
    this.active = "prompt";

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
    if (this.active === "panel") {
      return this.focusPrompt();
    }

    if (this.active === "prompt" && hasItems && this.panel !== "hidden") {
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
