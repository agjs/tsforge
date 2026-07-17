import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildScaffoldSteps, stateToAnswers } from "../src/scaffold/wizard";
import { answersToPlan } from "../src/scaffold/plan";
import { parseManifest } from "../src/scaffold/boringstack-manifest";
import { driveWizard, initWizard } from "../src/render/wizard";
import type { IWizardAction, IWizardState } from "../src/render/wizard.types";

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

/** Minimal wizard state carrying only the given single-select answers, for
 *  exercising a step's visibleWhen predicate in isolation. */
function base(single: Record<string, string>): IWizardState {
  return {
    stepIndex: 0,
    cursor: 0,
    single,
    multi: {},
    text: {},
    status: "active",
  };
}

describe("buildScaffoldSteps", () => {
  test("astro has no further config steps", () => {
    expect(buildScaffoldSteps(MANIFEST, "astro", "dev")).toEqual([]);
  });

  test("boringstack emits one select step per toggle/one-of/multi field (secrets + STACK excluded)", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    // STACK is driven by the top-level `stack` answer, not asked in the wizard.
    const selectable = MANIFEST.fields.filter(
      (f) =>
        f.key !== "STACK" &&
        (f.kind === "toggle" || f.kind === "one-of" || f.kind === "multi")
    );

    expect(steps).toHaveLength(selectable.length);
    expect(steps.map((s) => s.key)).toEqual(selectable.map((f) => f.key));
    // No secret/text field leaks into the interactive flow.
    expect(steps.some((s) => s.key === "JWT_SECRET")).toBe(false);
    // STACK mode (dev/prod/smoke) is NOT a wizard question.
    expect(steps.some((s) => s.key === "STACK")).toBe(false);
  });

  test("askWhen becomes a visibleWhen predicate on the dependent step", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const provider = steps.find((s) => s.key === "CACHE_PROVIDER");

    expect(provider?.visibleWhen).toBeDefined();
    // Shown only when the cache toggle recorded "1"; hidden for "0".
    expect(provider?.visibleWhen?.(base({ CACHE_ENABLED: "1" }))).toBe(true);
    expect(provider?.visibleWhen?.(base({ CACHE_ENABLED: "0" }))).toBe(false);

    // A field with no askWhen stays unconditional.
    const email = steps.find((s) => s.key === "EMAIL_PROVIDER");

    expect(email?.visibleWhen).toBeUndefined();
  });

  test("driving the wizard with the cache OFF never asks the cache provider", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    // CACHE_ENABLED default is on; toggle it off when we reach it, accept the rest.
    const actions: IWizardAction[] = steps.flatMap((s) =>
      s.key === "CACHE_ENABLED" ? ["down", "confirm"] : ["confirm"]
    );
    const state = driveWizard(steps, [...actions, "confirm"]);
    const answers = stateToAnswers(MANIFEST, "boringstack", "dev", state);

    // CACHE_PROVIDER was skipped → no recorded answer (planner uses the default).
    expect(answers.values.CACHE_ENABLED).toBe("0");
    expect(answers.values.CACHE_PROVIDER).toBeUndefined();
  });

  test("answering the cache provider then disabling the cache drops the stale answer", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const ci = steps.findIndex((s) => s.key === "CACHE_ENABLED");
    // Reach CACHE_ENABLED (cache on by default), confirm it, land on CACHE_PROVIDER,
    // pick "memory" (up from the "valkey" default), then go BACK to CACHE_ENABLED and
    // turn it OFF — the provider is now hidden. Finish to apply.
    const actions: IWizardAction[] = [
      ...Array.from({ length: ci }, (): IWizardAction => "confirm"),
      "confirm", // CACHE_ENABLED stays on → on CACHE_PROVIDER
      "up", // valkey → memory
      "confirm", // provider = memory → advance
      "back", // back to CACHE_PROVIDER
      "back", // back to CACHE_ENABLED
      "down", // → Disabled
      "confirm", // cache off → provider now hidden, skipped
      ...Array.from(
        { length: steps.length + 1 },
        (): IWizardAction => "confirm"
      ),
    ];
    const state = driveWizard(steps, actions);
    const answers = stateToAnswers(MANIFEST, "boringstack", "dev", state);
    const plan = answersToPlan(MANIFEST, answers);

    // The stale "memory" choice must NOT survive — the cache is off, so the answer
    // is dropped and the planner falls back to the default (as if never visited).
    expect(answers.values.CACHE_ENABLED).toBe("0");
    expect(answers.values.CACHE_PROVIDER).toBeUndefined();
    // The env edit therefore carries the DEFAULT ("valkey"), never the stale "memory".
    const providerEdit = plan.envEdits.find((e) => e.key === "CACHE_PROVIDER");

    expect(providerEdit?.value).toBe("valkey");
    expect(providerEdit?.value).not.toBe("memory");
    expect(
      plan.envEdits.some((e) => e.key === "CACHE_ENABLED" && e.value === "0")
    ).toBe(true);
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

  test("enabling AI shows the provider step and requires its secret (AI_ENABLED:* gate)", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const ai = steps.findIndex((s) => s.key === "AI_ENABLED");
    // AI defaults OFF (cursor on "Disabled"): "up" flips it on, then the now-visible
    // AI_PROVIDER step keeps its "openai" default.
    const actions: IWizardAction[] = [
      ...Array.from({ length: ai }, (): IWizardAction => "confirm"),
      "up", // AI_ENABLED → Enabled ("1")
      ...Array.from(
        { length: steps.length + 1 },
        (): IWizardAction => "confirm"
      ),
    ];
    const state = driveWizard(steps, actions);
    const answers = stateToAnswers(MANIFEST, "boringstack", "dev", state);
    const plan = answersToPlan(MANIFEST, answers);

    expect(answers.values.AI_ENABLED).toBe("1");
    expect(answers.values.AI_PROVIDER).toBe("openai"); // provider WAS asked
    // The secret must be required — the pre-existing "=true" gate never matched "1".
    expect(plan.requiredSecrets).toContain("OPENAI_API_KEY");
  });

  test("leaving AI off skips the provider step and requires no AI secret", () => {
    const steps = buildScaffoldSteps(MANIFEST, "boringstack", "dev");
    const state = driveWizard(steps, acceptAllDefaults(steps.length));
    const answers = stateToAnswers(MANIFEST, "boringstack", "dev", state);
    const plan = answersToPlan(MANIFEST, answers);

    expect(answers.values.AI_ENABLED).toBe("0");
    expect(answers.values.AI_PROVIDER).toBeUndefined(); // provider was skipped
    expect(plan.requiredSecrets).not.toContain("OPENAI_API_KEY");
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
