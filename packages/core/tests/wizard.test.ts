import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  driveWizard,
  initWizard,
  reduceWizard,
  renderFrame,
  runWizard,
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

      const done = runWizard(STEPS, false, () => "", out);

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
