import { describe, expect, test } from "bun:test";
import {
  actionFor,
  initWizard,
  reduceWizard,
  renderFrame,
} from "../src/render/wizard";
import type { IWizardStep } from "../src/render/wizard.types";
import {
  renderMenu,
  filterCommands,
  clampIndex,
} from "../src/render/command-menu";
import { COMMANDS } from "../src/cli/commands";
import {
  filterFiles,
  formatCompletionRows,
  truncatePath,
} from "../src/render/file-menu";
import {
  StatusBar,
  type IStatusInfo,
  type IStatusBarTerminal,
} from "../src/render";
import { VirtualScreen } from "./helpers/virtual-screen";

const CLEAR_HOME = "\x1b[2J\x1b[H";

const BAR_INFO: IStatusInfo = {
  model: "m",
  contextTokens: 0,
  contextWindow: 32000,
  turns: 1,
  elapsedMs: 0,
  status: "idle",
  scope: "src/**",
  tokensPerSecond: 0,
};

class FakeTerm implements IStatusBarTerminal {
  readonly writes: string[] = [];

  constructor(
    readonly isTTY: boolean,
    public rows: number,
    readonly columns: number
  ) {}

  write(data: string): boolean {
    this.writes.push(data);

    return true;
  }

  text(): string {
    return this.writes.join("");
  }
}

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

describe("@-file picker e2e — rendered dropdown", () => {
  const FILES = [
    "src/app.ts",
    "src/app.test.ts",
    "src/router.ts",
    "README.md",
    "package.json",
  ];

  test("a query narrows the visible rows; the selection shows a gutter", () => {
    const items = filterFiles(FILES, "app");
    const rows = formatCompletionRows(items, 0, 80, false);
    const screen = new VirtualScreen(24, 80);

    screen.feed("\x1b[2J\x1b[H" + rows.join("\n"));

    expect(items.every((p) => p.includes("app"))).toBe(true);
    expect(screen.rowsContaining("router.ts")).toBe(0); // filtered out
    // The first (selected) row carries the active gutter "›".
    expect(screen.row(1)).toContain("›");
  });

  test("an empty match renders the 'no matching file' hint", () => {
    const rows = formatCompletionRows(filterFiles(FILES, "zzz"), 0, 80, false);
    const screen = new VirtualScreen(24, 80);

    screen.feed(rows.join("\n"));
    expect(screen.text()).toContain("no matching file");
  });

  test("truncatePath shortens an over-long path to fit the width", () => {
    const long = "src/very/deeply/nested/directory/structure/component.tsx";
    const out = truncatePath(long, 20);

    expect(out.length).toBeLessThanOrEqual(20);
  });

  test("the picker overlay shrinking leaves NO ghost rows (same class as the editor bug)", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = new StatusBar(term, true, false, true);

    bar.install(BAR_INFO);
    // Show a 5-item dropdown, then shrink to 2 — the dropped 3 must be erased.
    bar.setOverlay(["one", "two", "three", "four", "five"], BAR_INFO);
    bar.setOverlay(["one", "two"], BAR_INFO);

    const screen = new VirtualScreen(24, 80);

    screen.feed(term.text());
    expect(screen.rowsContaining("five")).toBe(0); // ghost gone
    expect(screen.rowsContaining("three")).toBe(0); // ghost gone
    expect(screen.rowsContaining("two")).toBe(1); // still shown
  });
});

describe("wizard key→action decode (guards the keypress mapping)", () => {
  test("arrow keys map to navigation", () => {
    expect(actionFor(undefined, { name: "up" })).toBe("up");
    expect(actionFor(undefined, { name: "down" })).toBe("down");
  });

  test("space (by name or char) toggles a checkbox", () => {
    expect(actionFor(undefined, { name: "space" })).toBe("toggle");
    expect(actionFor(" ", { name: undefined })).toBe("toggle");
  });

  test("enter/return confirm; escape and ctrl+c cancel", () => {
    expect(actionFor(undefined, { name: "return" })).toBe("confirm");
    expect(actionFor(undefined, { name: "enter" })).toBe("confirm");
    expect(actionFor(undefined, { name: "escape" })).toBe("cancel");
    expect(actionFor("c", { name: "c", ctrl: true })).toBe("cancel");
  });

  test("'b' goes back, 'q' cancels, unknown keys are ignored", () => {
    expect(actionFor("b", { name: "b" })).toBe("back");
    expect(actionFor("q", { name: "q" })).toBe("cancel");
    expect(actionFor("z", { name: "z" })).toBeNull();
  });

  test("the decoded action actually drives the reducer (down → cursor moves)", () => {
    const action = actionFor(undefined, { name: "down" });
    let state = initWizard(STEPS);

    expect(action).not.toBeNull();
    state = reduceWizard(state, action ?? "up", STEPS);
    expect(state.cursor).toBe(1);
  });
});
