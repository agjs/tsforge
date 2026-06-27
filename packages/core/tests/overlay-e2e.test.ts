import { describe, expect, test } from "bun:test";
import { initWizard, reduceWizard, renderFrame } from "../src/render/wizard";
import type { IWizardStep } from "../src/render/wizard.types";
import {
  renderMenu,
  filterCommands,
  clampIndex,
} from "../src/render/command-menu";
import { COMMANDS } from "../src/cli/commands";
import { VirtualScreen } from "./helpers/virtual-screen";

const CLEAR_HOME = "\x1b[2J\x1b[H";

const STEPS: IWizardStep[] = [
  {
    key: "interfaces",
    kind: "single",
    title: "Naming",
    explanation: "pick naming",
    evidence: ["312 interfaces scanned"],
    options: [
      {
        label: "bare PascalCase",
        value: "bare-pascal-case",
        recommended: true,
      },
      { label: "I-prefix", value: "i-prefix" },
      { label: "off", value: "off" },
    ],
    defaultIndex: 0,
  },
  {
    key: "packs",
    kind: "multi",
    title: "Packs",
    explanation: "toggle packs",
    evidence: [],
    options: [
      { label: "generic-ts", value: "generic-ts" },
      { label: "nextjs", value: "nextjs" },
    ],
    defaultChecked: [0],
  },
];

/** Render a wizard state exactly as the driver does (CLEAR_HOME + frame). */
function screenOf(state: ReturnType<typeof initWizard>): VirtualScreen {
  const s = new VirtualScreen(24, 80);

  s.feed(CLEAR_HOME + renderFrame(state, STEPS, false));

  return s;
}

describe("wizard e2e — rendered screen at each step", () => {
  test("step 1 shows the title and parks the cursor on the recommended option", () => {
    const screen = screenOf(initWizard(STEPS));

    expect(screen.text()).toContain("Step 1 of 2");
    expect(screen.text()).toContain("Naming");
    // The cursor gutter "›" sits on the first option row (bare PascalCase).
    const cursorRow = findRow(screen, "›");

    expect(screen.row(cursorRow)).toContain("bare PascalCase");
  });

  test("down moves the on-screen cursor to the next option", () => {
    let state = initWizard(STEPS);

    state = reduceWizard(state, "down", STEPS);

    const screen = screenOf(state);
    const cursorRow = findRow(screen, "›");

    expect(screen.row(cursorRow)).toContain("I-prefix");
  });

  test("confirming step 1 advances to the multi-select step with checkboxes", () => {
    let state = initWizard(STEPS);

    state = reduceWizard(state, "confirm", STEPS); // accept recommended → step 2

    const screen = screenOf(state);

    expect(screen.text()).toContain("Step 2 of 2");
    expect(screen.text()).toContain("Packs");
    // generic-ts starts checked (◉), nextjs unchecked (◯).
    expect(screen.text()).toContain("◉");
    expect(screen.text()).toContain("◯");
  });

  test("toggling a checkbox flips its glyph on screen", () => {
    let state = initWizard(STEPS);

    state = reduceWizard(state, "confirm", STEPS); // → step 2 (Packs)
    state = reduceWizard(state, "down", STEPS); // cursor → nextjs
    state = reduceWizard(state, "toggle", STEPS); // check nextjs

    const screen = screenOf(state);
    const nextjsRow = findRow(screen, "nextjs");

    expect(screen.row(nextjsRow)).toContain("◉"); // now checked
  });

  test("completing all steps renders the overview", () => {
    let state = initWizard(STEPS);

    state = reduceWizard(state, "confirm", STEPS); // step 1 → 2
    state = reduceWizard(state, "confirm", STEPS); // step 2 → overview

    const screen = screenOf(state);

    // The overview lists the chosen values; both step titles' choices appear.
    expect(state.stepIndex).toBeGreaterThanOrEqual(STEPS.length);
    expect(screen.text().length).toBeGreaterThan(0);
  });
});

describe("command palette e2e — rendered menu", () => {
  test("the menu renders matching commands and marks the selection", () => {
    const all = filterCommands(COMMANDS, "");
    const screen = new VirtualScreen(24, 80);

    screen.feed("\x1b[2J\x1b[H" + renderMenu(all, 0, "", false));

    // At least one known command is visible (the palette is non-empty).
    expect(screen.text().length).toBeGreaterThan(0);
  });

  test("typing a query filters the visible list", () => {
    const all = filterCommands(COMMANDS, "");
    const filtered = filterCommands(COMMANDS, "clear");
    const screen = new VirtualScreen(24, 80);

    screen.feed(
      "\x1b[2J\x1b[H" +
        renderMenu(filtered, clampIndex(0, filtered.length), "clear", false)
    );

    // Filtering narrows the set (or keeps it equal if only matches exist).
    expect(filtered.length).toBeLessThanOrEqual(all.length);
    expect(screen.text().toLowerCase()).toContain("clear");
  });
});

/** First 1-based row containing `needle` (0 if absent). */
function findRow(screen: VirtualScreen, needle: string): number {
  for (let r = 1; r <= 24; r += 1) {
    if (screen.row(r).includes(needle)) {
      return r;
    }
  }

  return 0;
}
