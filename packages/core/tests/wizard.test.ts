import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  actionFor,
  driveWizard,
  initWizard,
  reduceWizard,
  renderFrame,
  runWizard,
  textValue,
  wizardOwnsRawMode,
} from "../src/render/wizard";
import type { IWizardStep } from "../src/render/wizard.types";

const STEPS: IWizardStep[] = [
  {
    key: "interfaces",
    kind: "single",
    title: "Naming",
    explanation: "pick naming",
    evidence: ["312 interfaces scanned", "300 bare PascalCase   User, Order"],
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
      { label: "generic-ts", value: "generic-ts", note: "always on" },
      { label: "nextjs", value: "nextjs" },
    ],
    defaultChecked: [0],
  },
];

describe("wizard reducer", () => {
  test("starts on the recommended option", () => {
    const s = initWizard(STEPS);

    expect(s.stepIndex).toBe(0);
    expect(s.cursor).toBe(0);
    expect(s.multi.packs).toEqual([0]);
  });

  test("down moves the cursor; confirm records + advances", () => {
    let s = initWizard(STEPS);

    s = reduceWizard(s, "down", STEPS); // cursor → i-prefix
    s = reduceWizard(s, "confirm", STEPS);

    expect(s.single.interfaces).toBe("i-prefix");
    expect(s.stepIndex).toBe(1);
  });

  test("space toggles a checkbox", () => {
    let s = initWizard(STEPS);

    s = reduceWizard(s, "confirm", STEPS); // → packs step
    s = reduceWizard(s, "down", STEPS); // cursor → nextjs
    s = reduceWizard(s, "toggle", STEPS); // check nextjs

    expect(s.multi.packs).toEqual([0, 1]);

    s = reduceWizard(s, "toggle", STEPS); // uncheck nextjs

    expect(s.multi.packs).toEqual([0]);
  });

  test("back from the first step cancels", () => {
    const s = reduceWizard(initWizard(STEPS), "back", STEPS);

    expect(s.status).toBe("cancel");
  });

  test("happy path: confirm through all steps → overview → apply", () => {
    const s = driveWizard(STEPS, ["confirm", "confirm", "confirm"]);

    // 2 steps + overview confirm = apply
    expect(s.status).toBe("apply");
    expect(s.single.interfaces).toBe("bare-pascal-case");
  });

  test("cancel anywhere stops with nothing applied", () => {
    const s = driveWizard(STEPS, ["confirm", "cancel"]);

    expect(s.status).toBe("cancel");
  });

  test("defensive: an empty steps array reaches a terminal state, never wedges", () => {
    // stepIndex 0 >= length 0 ⇒ already the overview; confirm applies, cancel cancels.
    expect(reduceWizard(initWizard([]), "confirm", []).status).toBe("apply");
    expect(reduceWizard(initWizard([]), "cancel", []).status).toBe("cancel");
  });

  test("defensive: init drops out-of-range defaultChecked indices", () => {
    const step: IWizardStep = {
      key: "m",
      kind: "multi",
      title: "M",
      explanation: "",
      evidence: [],
      options: [{ label: "a", value: "a" }],
      defaultChecked: [0, 5, 10],
    };

    expect(initWizard([step]).multi.m).toEqual([0]);
  });

  test("defensive: toggle on a zero-option multi is a no-op", () => {
    const step: IWizardStep = {
      key: "empty",
      kind: "multi",
      title: "E",
      explanation: "",
      evidence: [],
      options: [],
    };

    const s = reduceWizard(initWizard([step]), "toggle", [step]);

    expect(s.multi.empty).toEqual([]);
  });

  test("back from overview returns to the last step", () => {
    let s = driveWizard(STEPS, ["confirm", "confirm"]); // at overview

    expect(s.stepIndex).toBe(STEPS.length);

    s = reduceWizard(s, "back", STEPS);
    expect(s.stepIndex).toBe(STEPS.length - 1);
    expect(s.status).toBe("active");
  });
});

describe("wizard render (no color)", () => {
  test("step frame shows progress, evidence, cursor, recommended", () => {
    const frame = renderFrame(initWizard(STEPS), STEPS, false);

    expect(frame).toContain("Step 1 of 2 · Naming");
    expect(frame).toContain("312 interfaces scanned");
    expect(frame).toContain("› bare PascalCase");
    expect(frame).toContain("recommended");
    expect(frame).toContain("enter select");
  });

  test("checkbox step shows checked/unchecked markers", () => {
    const s = reduceWizard(initWizard(STEPS), "confirm", STEPS); // packs step
    const frame = renderFrame(s, STEPS, false);

    expect(frame).toContain("◉ generic-ts");
    expect(frame).toContain("◯ nextjs");
    expect(frame).toContain("always on");
    expect(frame).toContain("space toggle");
  });

  test("overview lists choices and the extra preview; nothing-written language", () => {
    const s = driveWizard(STEPS, ["confirm", "confirm"]);
    const frame = renderFrame(s, STEPS, false, "PREVIEW-BLOCK");

    expect(frame).toContain("nothing is written until you Apply");
    expect(frame).toContain("Naming: bare PascalCase");
    expect(frame).toContain("PREVIEW-BLOCK");
    expect(frame).toContain("enter apply");
  });
});

describe("runWizard interactive teardown", () => {
  /** A minimal TTY-shaped stdin: an EventEmitter plus the stream methods the
   *  driver / emitKeypressEvents touch. We drive it by emitting `keypress`. */
  class FakeStdin extends EventEmitter {
    isTTY = true;

    setRawMode(): this {
      return this;
    }

    resume(): this {
      return this;
    }

    pause(): this {
      return this;
    }

    setEncoding(): this {
      return this;
    }
  }

  test("finish() restores listeners and resolves even when the terminal write throws", async () => {
    const fake = new FakeStdin();
    // A pre-existing keypress listener that MUST survive (be restored) on exit.
    let preexistingCalls = 0;

    const preexisting = (): void => {
      preexistingCalls += 1;
    };

    fake.on("keypress", preexisting);

    const realStdin = process.stdin;

    Object.defineProperty(process, "stdin", {
      value: fake,
      configurable: true,
    });

    try {
      // `out` throws on the finish-specific write (SHOW_CURSOR = ESC[?25h),
      // simulating an EPIPE on a closed stdout during teardown.
      const out = (s: string): void => {
        if (s.includes("[?25h")) {
          throw new Error("EPIPE: terminal write failed");
        }
      };

      const done = runWizard(STEPS, false, { extra: () => "", out });

      // Drive a cancel keypress → terminal state → finish() (whose out throws).
      fake.emit("keypress", undefined, { name: "escape" });

      // The fix's guarantee: the promise still resolves (no hang)...
      const state = await done;

      expect(state.status).toBe("cancel");

      // ...exactly one keypress listener remains (the restored one, not onKey)...
      expect(fake.listeners("keypress").length).toBe(1);

      // ...and it forwards to the original listener (restoration really happened).
      fake.emit("keypress", undefined, { name: "down" });
      expect(preexistingCalls).toBe(1);
    } finally {
      Object.defineProperty(process, "stdin", {
        value: realStdin,
        configurable: true,
      });
    }
  });
});

// ── generic-wizard additions: text steps, optional review, title ─────────────

const urlStep: IWizardStep = {
  key: "baseUrl",
  kind: "text",
  title: "Base URL",
  explanation: "The API root",
  evidence: [],
  options: [],
  default: "http://localhost:8000/v1",
};

const nameStep: IWizardStep = {
  key: "name",
  kind: "text",
  title: "Name",
  explanation: "type a name",
  evidence: [],
  options: [],
};

const keyStep: IWizardStep = {
  key: "apiKey",
  kind: "text",
  title: "API key",
  explanation: "Secret",
  evidence: [],
  options: [],
  mask: true,
  validate: (v) => (v.length === 0 ? "required" : null),
};

describe("generic wizard: text steps", () => {
  test("text step seeds its default and carries it forward on confirm", () => {
    const s = driveWizard([urlStep], ["confirm"]);

    expect(s.text.baseUrl).toBe("http://localhost:8000/v1");
    expect(s.stepIndex).toBe(1); // review on → overview, not applied yet
  });

  test("typed characters append; erase backspaces", () => {
    const s = driveWizard(
      [nameStep],
      [{ char: "a" }, { char: "b" }, { char: "c" }, "erase"]
    );

    expect(textValue(s, nameStep)).toBe("ab");
  });

  test("a failing validator blocks confirm", () => {
    const s = driveWizard([keyStep], ["confirm"]); // empty → invalid

    expect(s.stepIndex).toBe(0); // did not advance
  });

  test("review:false applies on the last step's confirm", () => {
    const s = driveWizard([nameStep], [{ char: "x" }, "confirm"], {
      review: false,
    });

    expect(s.status).toBe("apply");
    expect(s.text.name).toBe("x");
  });

  test("renderFrame uses the supplied title", () => {
    const frame = renderFrame(
      initWizard([urlStep]),
      [urlStep],
      false,
      "",
      "config"
    );

    expect(frame).toContain("config");
    expect(frame).not.toContain("tsforge setup");
  });

  test("text render masks the value and shows a validation error when empty", () => {
    const typed = driveWizard([keyStep], [{ char: "s" }, { char: "k" }]);
    const frame = renderFrame(typed, [keyStep], false, "", "config");

    expect(frame).toContain("••");
    expect(frame).not.toContain("sk");

    const empty = renderFrame(
      initWizard([keyStep]),
      [keyStep],
      false,
      "",
      "config"
    );

    expect(empty).toContain("required");
  });

  test("actionFor: printable → char, backspace → erase, arrows unchanged", () => {
    expect(actionFor("x", { name: "x" })).toEqual({ char: "x" });
    expect(actionFor(undefined, { name: "backspace" })).toBe("erase");
    expect(actionFor(undefined, { name: "up" })).toBe("up");
  });
});

describe("generic wizard: text input edge cases", () => {
  test("a space is typed into a text field (regression: space→toggle)", () => {
    const s = driveWizard(
      [nameStep],
      [{ char: "a" }, { char: " " }, { char: "b" }]
    );

    expect(textValue(s, nameStep)).toBe("a b");
  });

  test("actionFor: DEL/backspace decodes as erase, never a printable char", () => {
    expect(actionFor("\x7f", { name: "backspace" })).toBe("erase");
    // A bare DEL byte with no key name is not printable → ignored, not a char.
    expect(actionFor("\x7f", { name: undefined })).toBeNull();
  });
});

describe("wizardOwnsRawMode: raw-mode ownership rule", () => {
  test("a standalone TTY with no pre-existing keypress listeners owns raw mode", () => {
    expect(wizardOwnsRawMode(true, true, true, 0)).toBe(true);
  });

  test("manageInput:false (REPL-launched) NEVER owns raw mode", () => {
    // The REPL editor already owns stdin; if the wizard toggled raw mode / paused
    // stdin on exit it would empty the event loop and quit the process.
    expect(wizardOwnsRawMode(false, true, true, 0)).toBe(false);
  });

  test("a non-TTY never owns raw mode", () => {
    expect(wizardOwnsRawMode(true, false, true, 0)).toBe(false);
  });

  test("pre-existing keypress listeners mean another consumer owns stdin", () => {
    expect(wizardOwnsRawMode(true, true, true, 1)).toBe(false);
  });

  test("a stdin without setRawMode never owns raw mode", () => {
    expect(wizardOwnsRawMode(true, true, false, 0)).toBe(false);
  });
});

describe("conditional step visibility (visibleWhen)", () => {
  // A: an enable toggle ("1"/"0"). B: shown only when A === "1". C: always shown.
  const COND: IWizardStep[] = [
    {
      key: "A",
      kind: "single",
      title: "Enable cache",
      explanation: "on?",
      evidence: [],
      options: [
        { label: "Enabled", value: "1" },
        { label: "Disabled", value: "0" },
      ],
      defaultIndex: 0,
    },
    {
      key: "B",
      kind: "single",
      title: "Cache provider",
      explanation: "which?",
      evidence: [],
      options: [
        { label: "memory", value: "memory" },
        { label: "valkey", value: "valkey" },
      ],
      defaultIndex: 1,
      visibleWhen: (s) => s.single.A === "1",
    },
    {
      key: "C",
      kind: "single",
      title: "Notifications",
      explanation: "on?",
      evidence: [],
      options: [
        { label: "Enabled", value: "1" },
        { label: "Disabled", value: "0" },
      ],
      defaultIndex: 0,
    },
  ];

  test("confirming the gate ON shows the dependent step next", () => {
    let s = initWizard(COND);

    expect(s.stepIndex).toBe(0); // A is visible from the start
    // cursor already on "Enabled" (index 0) → confirm keeps A="1".
    s = reduceWizard(s, "confirm", COND);
    expect(s.stepIndex).toBe(1); // B is shown because A === "1"
  });

  test("confirming the gate OFF skips the dependent step", () => {
    let s = initWizard(COND);

    s = reduceWizard(s, "down", COND); // move cursor to "Disabled"
    s = reduceWizard(s, "confirm", COND); // A = "0"
    expect(s.single.A).toBe("0");
    expect(s.stepIndex).toBe(2); // jumped over B straight to C
  });

  test("going back from C skips the hidden dependent step", () => {
    let s = initWizard(COND);

    s = reduceWizard(s, "down", COND);
    s = reduceWizard(s, "confirm", COND); // A="0", now on C (index 2)
    expect(s.stepIndex).toBe(2);
    s = reduceWizard(s, "back", COND); // back must skip hidden B → A
    expect(s.stepIndex).toBe(0);
  });

  test("the review overview omits a hidden step", () => {
    let s = initWizard(COND);

    s = reduceWizard(s, "down", COND);
    s = reduceWizard(s, "confirm", COND); // A="0" → B hidden
    s = reduceWizard(s, "confirm", COND); // confirm C → overview
    const frame = renderFrame(s, COND, false);

    expect(frame).toContain("Enable cache");
    expect(frame).toContain("Notifications");
    expect(frame).not.toContain("Cache provider"); // hidden B absent from review
  });

  test('"Step X of N" reflects the visible count, not the raw index', () => {
    let s = initWizard(COND);

    s = reduceWizard(s, "down", COND);
    s = reduceWizard(s, "confirm", COND); // A="0" → only A and C are visible
    // Now on C: it is the 2nd (and last) visible step of 2.
    expect(renderFrame(s, COND, false)).toContain("Step 2 of 2");
  });

  test('"Step X of N" counts a default-ON gate\'s dependent before it is confirmed', () => {
    // A defaults to "Enabled" (index 0 = "1"), so B is visible on the default path.
    // On step A (unanswered yet), the total must already be 3 — not 2 that jumps to 3.
    const s = initWizard(COND);

    expect(s.stepIndex).toBe(0);
    expect(renderFrame(s, COND, false)).toContain("Step 1 of 3");
  });

  test("review:false applies immediately when every remaining step is hidden", () => {
    const steps: IWizardStep[] = [
      {
        key: "a",
        kind: "single",
        title: "A",
        explanation: "",
        evidence: [],
        options: [{ label: "x", value: "x" }],
        defaultIndex: 0,
      },
      {
        key: "b",
        kind: "single",
        title: "B",
        explanation: "",
        evidence: [],
        options: [{ label: "y", value: "y" }],
        defaultIndex: 0,
        visibleWhen: () => false, // never shown
      },
    ];
    let s = initWizard(steps); // on A (index 0)

    expect(s.stepIndex).toBe(0);
    // Confirming A with review off: the only remaining step (B) is hidden, so the
    // wizard applies immediately instead of stopping on a hidden step.
    s = reduceWizard(s, "confirm", steps, { review: false });
    expect(s.status).toBe("apply");
  });

  test("overview back cancels when every step is hidden (no dead-end)", () => {
    const allHidden: IWizardStep[] = [
      {
        key: "x",
        kind: "single",
        title: "X",
        explanation: "",
        evidence: [],
        options: [{ label: "a", value: "a" }],
        defaultIndex: 0,
        visibleWhen: () => false,
      },
    ];
    let s = initWizard(allHidden);

    expect(s.stepIndex).toBe(allHidden.length); // straight to the overview
    s = reduceWizard(s, "back", allHidden);
    expect(s.status).toBe("cancel");
  });

  test("review ON: a step whose gate is on still shows the dependent in the overview", () => {
    let s = initWizard(COND);

    s = reduceWizard(s, "confirm", COND); // A="1" → B visible, now on B
    s = reduceWizard(s, "confirm", COND); // confirm B (valkey default)
    s = reduceWizard(s, "confirm", COND); // confirm C → overview
    const frame = renderFrame(s, COND, false);

    expect(frame).toContain("Cache provider");
    expect(frame).toContain("valkey"); // its chosen value appears in the review
  });

  test("initWizard lands on the first VISIBLE step when step 0 is initially hidden", () => {
    const steps: IWizardStep[] = [
      {
        key: "hidden",
        kind: "single",
        title: "Never shown",
        explanation: "",
        evidence: [],
        options: [{ label: "x", value: "x" }],
        defaultIndex: 0,
        visibleWhen: () => false,
      },
      {
        key: "shown",
        kind: "single",
        title: "First visible",
        explanation: "",
        evidence: [],
        options: [{ label: "y", value: "y" }],
        defaultIndex: 0,
      },
    ];
    const s = initWizard(steps);

    expect(s.stepIndex).toBe(1);
  });

  test("answering a dependent then flipping the gate off re-hides it (review omits it; engine keeps the raw value for the projection layer to drop)", () => {
    let s = initWizard(COND);

    s = reduceWizard(s, "confirm", COND); // A="1" → on B
    s = reduceWizard(s, "confirm", COND); // B="valkey" (default) → on C
    s = reduceWizard(s, "back", COND); // back to B (still visible, A="1")
    expect(s.stepIndex).toBe(1);
    s = reduceWizard(s, "back", COND); // back to A
    expect(s.stepIndex).toBe(0);
    s = reduceWizard(s, "down", COND); // cursor → Disabled
    s = reduceWizard(s, "confirm", COND); // A="0" → B now hidden, skip to C
    expect(s.stepIndex).toBe(2);
    s = reduceWizard(s, "confirm", COND); // confirm C → overview

    const frame = renderFrame(s, COND, false);

    expect(frame).not.toContain("Cache provider"); // hidden B omitted from review
    // The engine intentionally does NOT clear B's recorded value; dropping the
    // stale answer is the projection layer's job (scaffold stateToAnswers).
    expect(s.single.B).toBe("valkey");
  });
});
