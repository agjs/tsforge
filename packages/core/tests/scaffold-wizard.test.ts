import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildScaffoldSteps, stateToAnswers } from "../src/scaffold/wizard";
import { answersToPlan } from "../src/scaffold/plan";
import { parseManifest } from "../src/scaffold/boringstack-manifest";
import { driveWizard, initWizard } from "../src/render/wizard";
import type { IWizardAction } from "../src/render/wizard.types";

const MANIFEST = parseManifest(
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
      "utf8"
    )
  )
);

/** Confirm straight through every step + the overview, accepting defaults. */
function acceptAllDefaults(stepCount: number): readonly IWizardAction[] {
  return Array.from({ length: stepCount + 1 }, () => "confirm");
}

describe("buildScaffoldSteps", () => {
  test("astro has no further config steps", () => {
    expect(buildScaffoldSteps(MANIFEST, "astro", "dev")).toEqual([]);
  });

  test("boringstack emits one select step per toggle/one-of/multi field (secrets excluded)", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const selectable = MANIFEST.fields.filter(
      (f) => f.kind === "toggle" || f.kind === "one-of" || f.kind === "multi"
    );

    expect(steps).toHaveLength(selectable.length);
    expect(steps.map((s) => s.key)).toEqual(selectable.map((f) => f.key));
    // No secret/text field leaks into the interactive flow.
    expect(steps.some((s) => s.key === "JWT_SECRET")).toBe(false);
  });

  test("a toggle becomes a 2-option single step, default reflecting the stack", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const obs = steps.find((s) => s.key === "WITH_OBSERVABILITY");

    expect(obs?.kind).toBe("single");
    expect(obs?.options).toHaveLength(2);
    // devDefault "1" → the "on" option preselected (index 0).
    expect(obs?.defaultIndex).toBe(0);

    // WUD has no devDefault (prod-only) → off by default in dev.
    const wud = steps.find((s) => s.key === "WUD");

    expect(wud?.defaultIndex).toBe(1);
  });

  test("a one-of step carries its options, default index at the stack default", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const email = steps.find((s) => s.key === "EMAIL_PROVIDER");

    expect(email?.kind).toBe("single");
    expect(email?.options.map((o) => o.value)).toEqual([
      "cloudflare",
      "resend",
      "sendgrid",
      "smtp",
    ]);
    expect(email?.defaultIndex).toBe(0); // cloudflare
  });

  test("a multi step seeds defaultChecked from the stack default", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const oauth = steps.find((s) => s.key === "OAUTH_PROVIDERS");

    expect(oauth?.kind).toBe("multi");
    expect(oauth?.defaultChecked ?? []).toEqual([]); // none on by default
  });
});

describe("wizard flow → answers → plan", () => {
  test("accepting all defaults reproduces the dev-default topology", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const state = driveWizard(steps, acceptAllDefaults(steps.length));
    const answers = stateToAnswers(MANIFEST, "boringstack", "dev", state);
    const plan = answersToPlan(MANIFEST, answers);

    // Dev defaults boot the full observability + glitchtip + mailpit + bullmq set.
    expect(plan.services).toContain("grafana");
    expect(plan.services).toContain("glitchtip-web");
    expect(plan.services).toContain("mailpit");
    expect(plan.violations).toEqual([]);
  });

  test("toggling observability OFF removes exactly its services", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const idx = steps.findIndex((s) => s.key === "WITH_OBSERVABILITY");
    // Walk to the observability step, move cursor to the "off" option, confirm,
    // then accept every remaining default.
    const actions: IWizardAction[] = [
      ...Array.from({ length: idx }, (): IWizardAction => "confirm"),
      "down", // off
      ...Array.from(
        { length: steps.length - idx },
        (): IWizardAction => "confirm"
      ),
    ];
    const state = driveWizard(steps, actions);
    const plan = answersToPlan(
      MANIFEST,
      stateToAnswers(MANIFEST, "boringstack", "dev", state)
    );

    for (const svc of [
      "grafana",
      "prometheus",
      "loki",
      "tempo",
      "alertmanager",
    ]) {
      expect(plan.services).not.toContain(svc);
    }

    // Unrelated services survive.
    expect(plan.services).toContain("glitchtip-web");
    expect(plan.services).toContain("api");
  });

  test("choosing an email provider surfaces its required secret", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const idx = steps.findIndex((s) => s.key === "EMAIL_PROVIDER");
    // cloudflare(0) → resend(1): one "down" then confirm.
    const actions: IWizardAction[] = [
      ...Array.from({ length: idx }, (): IWizardAction => "confirm"),
      "down", // resend
      ...Array.from(
        { length: steps.length - idx },
        (): IWizardAction => "confirm"
      ),
    ];
    const plan = answersToPlan(
      MANIFEST,
      stateToAnswers(
        MANIFEST,
        "boringstack",
        "dev",
        driveWizard(steps, actions)
      )
    );

    expect(plan.requiredSecrets).toContain("RESEND_API_KEY");
    expect(plan.requiredSecrets).not.toContain("CLOUDFLARE_EMAIL_API_TOKEN");
  });

  test("checking an OAuth provider surfaces its credential secrets", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const idx = steps.findIndex((s) => s.key === "OAUTH_PROVIDERS");
    // Walk to the multi step, toggle the first option (google), continue.
    const actions: IWizardAction[] = [
      ...Array.from({ length: idx }, (): IWizardAction => "confirm"),
      "toggle", // google (cursor starts at 0)
      ...Array.from(
        { length: steps.length - idx },
        (): IWizardAction => "confirm"
      ),
    ];
    const plan = answersToPlan(
      MANIFEST,
      stateToAnswers(
        MANIFEST,
        "boringstack",
        "dev",
        driveWizard(steps, actions)
      )
    );

    expect(plan.requiredSecrets).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(plan.requiredSecrets).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
  });

  test("stateToAnswers carries the chosen stack through to the plan", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "prod");
    const answers = stateToAnswers(
      MANIFEST,
      "boringstack",
      "prod",
      initWizard(steps)
    );

    expect(answers.stack).toBe("prod");
    expect(answers.archetype).toBe("boringstack");
  });
});
