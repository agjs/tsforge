import { isRecord } from "../lib/guards";
import type { IRenderExpect, IStep } from "./oracle";

/**
 * Parse a checks JSON (authored by the model/user) into render expectations +
 * interaction steps, defensively (no `as`/`!` — validates the boundary). Shape:
 *   { "expect": { "selector": "#x", "text": "ok" },
 *     "steps": [ { "click": "#inc", "expect": { "selector": "#n", "text": "1" } },
 *                { "fill": { "selector": "#in", "value": "hi" } } ] }
 */
export function parseChecks(raw: unknown): {
  expect?: IRenderExpect;
  steps?: IStep[];
} {
  if (!isRecord(raw)) {
    return {};
  }

  const expect = toExpect(raw.expect);
  const steps = toSteps(raw.steps);

  return {
    ...(expect !== undefined ? { expect } : {}),
    ...(steps.length > 0 ? { steps } : {}),
  };
}

function toExpect(raw: unknown): IRenderExpect | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const expect: IRenderExpect = {};

  if (typeof raw.selector === "string") {
    expect.selector = raw.selector;
  }

  if (typeof raw.text === "string") {
    expect.text = raw.text;
  }

  return expect.selector !== undefined || expect.text !== undefined
    ? expect
    : undefined;
}

function toStep(raw: unknown): IStep | null {
  if (!isRecord(raw)) {
    return null;
  }

  const step: IStep = {};

  if (typeof raw.click === "string") {
    step.click = raw.click;
  }

  if (
    isRecord(raw.fill) &&
    typeof raw.fill.selector === "string" &&
    typeof raw.fill.value === "string"
  ) {
    step.fill = { selector: raw.fill.selector, value: raw.fill.value };
  }

  const expect = toExpect(raw.expect);

  if (expect !== undefined) {
    step.expect = expect;
  }

  return step.click !== undefined ||
    step.fill !== undefined ||
    step.expect !== undefined
    ? step
    : null;
}

function toSteps(raw: unknown): IStep[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const steps: IStep[] = [];

  for (const item of raw) {
    const step = toStep(item);

    if (step !== null) {
      steps.push(step);
    }
  }

  return steps;
}
