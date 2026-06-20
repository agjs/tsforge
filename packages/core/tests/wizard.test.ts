import { describe, test, expect } from "bun:test";
import {
  driveWizard,
  initWizard,
  reduceWizard,
  renderFrame,
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
