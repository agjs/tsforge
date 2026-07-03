/**
 * Tiny harness for the real-pty wizard e2e (scripts/e2e-wizard-pty.py): runs the
 * generic wizard with a mixed step set (single + text) and prints the final result
 * as one JSON line so the driver can assert on it.
 */
import { runWizard } from "../src/render/wizard";
import type { IWizardStep } from "../src/render/wizard.types";

const steps: IWizardStep[] = [
  {
    key: "pick",
    kind: "single",
    title: "Pick one",
    explanation: "choose",
    evidence: [],
    options: [
      { label: "alpha", value: "alpha", recommended: true },
      { label: "beta", value: "beta" },
    ],
  },
  {
    key: "name",
    kind: "text",
    title: "Name",
    explanation: "type a name",
    evidence: [],
    options: [],
    default: "seed",
  },
];

const state = await runWizard(steps, false, {
  title: "harness",
  review: false,
});

process.stdout.write(
  `\nRESULT ${JSON.stringify({ status: state.status, single: state.single, text: state.text })}\n`
);
