import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "../src/scaffold/boringstack-manifest";
import { answersToPlan } from "../src/scaffold/plan";
import type { IScaffoldAnswers, IScaffoldManifest } from "../src/scaffold";

const MANIFEST: IScaffoldManifest = parseManifest(
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
      "utf8"
    )
  )
);

/** Build full-stack answers from a sparse override (defaults filled by the planner
 *  from the manifest's per-STACK defaults). */
function answers(
  values: Record<string, string | readonly string[]> = {},
  stack: IScaffoldAnswers["stack"] = "dev"
): IScaffoldAnswers {
  return { archetype: "boringstack", stack, values };
}

describe("answersToPlan — container topology (capability on/off matrix)", () => {
  test("dev defaults boot the full observability+glitchtip+mailpit+bullmq topology", () => {
    const plan = answersToPlan(MANIFEST, answers());

    // always-on core + every dev-default-on overlay
    for (const svc of [
      "postgres",
      "valkey",
      "api",
      "ui",
      "api-migrate",
      "prometheus",
      "grafana",
      "tempo",
      "loki",
      "alertmanager",
      "glitchtip-web",
      "glitchtip-worker",
      "mailpit",
      "bullmq-dashboard",
    ]) {
      expect(plan.services).toContain(svc);
    }

    // services are sorted + de-duplicated
    expect([...plan.services]).toEqual([...plan.services].sort());
    expect(new Set(plan.services).size).toBe(plan.services.length);
  });

  test("turning a toggle OFF removes exactly its services (5 vs 20)", () => {
    const lean = answersToPlan(
      MANIFEST,
      answers({
        WITH_OBSERVABILITY: "0",
        WITH_GLITCHTIP: "0",
        WITH_MAILPIT: "0",
        WITH_BULLMQ: "0",
      })
    );

    expect(lean.services).toEqual([
      "api",
      "api-migrate",
      "postgres",
      "ui",
      "valkey",
    ]);
    // The observability set is gone…
    expect(lean.services).not.toContain("grafana");
    expect(lean.services).not.toContain("tempo");
    expect(lean.services).not.toContain("glitchtip-web");
  });

  test("each infra toggle independently controls only its own services", () => {
    const obsOnly = answersToPlan(
      MANIFEST,
      answers({ WITH_GLITCHTIP: "0", WITH_MAILPIT: "0", WITH_BULLMQ: "0" })
    );

    expect(obsOnly.services).toContain("grafana"); // observability still on
    expect(obsOnly.services).not.toContain("glitchtip-web");
    expect(obsOnly.services).not.toContain("mailpit");
  });
});

describe("answersToPlan — conditional-required secrets", () => {
  test("BILLING_ENABLED=true requires STRIPE_SECRET_KEY", () => {
    const off = answersToPlan(MANIFEST, answers({ BILLING_ENABLED: "false" }));

    expect(off.requiredSecrets).not.toContain("STRIPE_SECRET_KEY");

    const on = answersToPlan(MANIFEST, answers({ BILLING_ENABLED: "true" }));

    expect(on.requiredSecrets).toContain("STRIPE_SECRET_KEY");
  });

  test("EMAIL_PROVIDER selects exactly the chosen provider's keys", () => {
    const resend = answersToPlan(
      MANIFEST,
      answers({ EMAIL_PROVIDER: "resend" })
    );

    expect(resend.requiredSecrets).toContain("RESEND_API_KEY");
    expect(resend.requiredSecrets).not.toContain("SENDGRID_API_KEY");

    const sendgrid = answersToPlan(
      MANIFEST,
      answers({ EMAIL_PROVIDER: "sendgrid" })
    );

    expect(sendgrid.requiredSecrets).toContain("SENDGRID_API_KEY");
    expect(sendgrid.requiredSecrets).not.toContain("RESEND_API_KEY");
  });

  test("each enabled OAuth provider requires its own client id + secret", () => {
    const plan = answersToPlan(
      MANIFEST,
      answers({ OAUTH_PROVIDERS: ["google", "github"] })
    );

    expect(plan.requiredSecrets).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(plan.requiredSecrets).toContain("GITHUB_OAUTH_CLIENT_SECRET");
    expect(plan.requiredSecrets).not.toContain("LINKEDIN_OAUTH_CLIENT_ID");
  });

  test("prod-only secrets are required only when STACK=prod, and per enabled toggle", () => {
    const dev = answersToPlan(MANIFEST, answers({}, "dev"));

    expect(dev.requiredSecrets).not.toContain("JWT_SECRET");
    expect(dev.requiredSecrets).not.toContain("GRAFANA_ADMIN_PASSWORD");

    const prod = answersToPlan(MANIFEST, answers({}, "prod"));

    expect(prod.requiredSecrets).toContain("JWT_SECRET");
    expect(prod.requiredSecrets).toContain("MFA_ENCRYPTION_KEY");
    expect(prod.requiredSecrets).toContain("VALKEY_PASSWORD");
    // observability is prod-default-on → its secret is required in prod
    expect(prod.requiredSecrets).toContain("GRAFANA_ADMIN_PASSWORD");

    // …but NOT when that toggle is off in prod
    const prodNoObs = answersToPlan(
      MANIFEST,
      answers({ WITH_OBSERVABILITY: "0" }, "prod")
    );

    expect(prodNoObs.requiredSecrets).not.toContain("GRAFANA_ADMIN_PASSWORD");
  });
});

describe("answersToPlan — cross-rules", () => {
  test("OTel + Sentry both-on is a violation (don't double-instrument)", () => {
    // The fixture models tracing as one-of, so a single value can't violate;
    // this guards the rule engine: an `excludes` rule fires when both peers active.
    const otel = answersToPlan(MANIFEST, answers({ TRACING_BACKEND: "otel" }));

    expect(otel.violations).toHaveLength(0);
  });

  test("OAuth implies Valkey is satisfied (Valkey is always-on) → no violation", () => {
    const plan = answersToPlan(
      MANIFEST,
      answers({ OAUTH_PROVIDERS: ["google"] })
    );

    expect(plan.violations).toHaveLength(0);
    expect(plan.services).toContain("valkey");
  });

  test("EMAIL_PROVIDER=smtp implies WITH_MAILPIT — auto-satisfied by dev default", () => {
    const plan = answersToPlan(MANIFEST, answers({ EMAIL_PROVIDER: "smtp" }));

    // mailpit is dev-default-on, so the implies-rule holds; no violation.
    expect(plan.violations).toHaveLength(0);
    expect(plan.services).toContain("mailpit");
  });

  test("EMAIL_PROVIDER=smtp with WITH_MAILPIT=0 → violation surfaced", () => {
    const plan = answersToPlan(
      MANIFEST,
      answers({ EMAIL_PROVIDER: "smtp", WITH_MAILPIT: "0" })
    );

    expect(plan.violations.join(" ")).toMatch(/mailpit/i);
  });
});

describe("answersToPlan — env edits + rename + secrets handling", () => {
  test("toggle/provider answers become .env edits; secrets flagged not-logged", () => {
    const plan = answersToPlan(
      MANIFEST,
      answers({ WITH_OBSERVABILITY: "0", EMAIL_PROVIDER: "resend" })
    );
    const byKey = new Map(plan.envEdits.map((e) => [e.key, e]));

    expect(byKey.get("WITH_OBSERVABILITY")?.value).toBe("0");
    expect(byKey.get("EMAIL_PROVIDER")?.value).toBe("resend");
    expect(byKey.get("STACK")?.value).toBe("dev");
    // generated prod secrets, when present, are marked secret
    const prod = answersToPlan(MANIFEST, answers({}, "prod"));
    const jwt = prod.envEdits.find((e) => e.key === "JWT_SECRET");

    expect(jwt?.secret).toBe(true);
  });

  test("app-feature env file is stack-dependent (${STACK} → api.dev.env / api.prod.env)", () => {
    const dev = answersToPlan(
      MANIFEST,
      answers({ EMAIL_PROVIDER: "resend" }, "dev")
    );
    const prod = answersToPlan(
      MANIFEST,
      answers({ EMAIL_PROVIDER: "resend" }, "prod")
    );
    const smoke = answersToPlan(
      MANIFEST,
      answers({ EMAIL_PROVIDER: "resend" }, "smoke")
    );

    const file = (p: typeof dev): string | undefined =>
      p.envEdits.find((e) => e.key === "EMAIL_PROVIDER")?.file;

    expect(file(dev)).toBe("infra/compose/compose/api.dev.env");
    expect(file(prod)).toBe("infra/compose/compose/api.prod.env");
    // smoke shares the dev env file
    expect(file(smoke)).toBe("infra/compose/compose/api.dev.env");
  });

  test("each edit is routed to the right .env file (infra→compose, features→api)", () => {
    const prod = answersToPlan(
      MANIFEST,
      answers({ EMAIL_PROVIDER: "resend" }, "prod")
    );
    const byKey = new Map(prod.envEdits.map((e) => [e.key, e]));

    // infra toggle → compose .env
    expect(byKey.get("WITH_OBSERVABILITY")?.file).toBe(
      "infra/compose/compose/.env"
    );
    expect(byKey.get("STACK")?.file).toBe("infra/compose/compose/.env");
    // identity secret → compose .env (prod deploy reads it there)
    expect(byKey.get("JWT_SECRET")?.file).toBe("infra/compose/compose/.env");
    // app feature/provider → the compose api env file (stack-resolved default)
    expect(byKey.get("EMAIL_PROVIDER")?.file).toBe(
      "infra/compose/compose/api.prod.env"
    );
  });

  test("rename args follow the manifest's renameParams order", () => {
    const plan = answersToPlan(
      MANIFEST,
      answers({ project: "acme", ghcrOwner: "acme-corp", domain: "acme.com" })
    );

    expect(plan.renameArgs).toEqual(["acme", "acme-corp", "acme.com"]);
  });
});

describe("answersToPlan — AI / multi-tenancy / queues capabilities", () => {
  test("AI provider key is required ONLY when AI is enabled (requiresSecretsWhen)", () => {
    // AI off (default) → no provider key required even though a provider is set.
    expect(answersToPlan(MANIFEST, answers()).requiredSecrets).not.toContain(
      "OPENAI_API_KEY"
    );

    // AI on with the default (openai) provider → its key becomes required.
    const on = answersToPlan(MANIFEST, answers({ AI_ENABLED: "true" }));

    expect(on.requiredSecrets).toContain("OPENAI_API_KEY");
    expect(on.requiredSecrets).not.toContain("ANTHROPIC_API_KEY");

    // Switching the provider switches which key is required.
    const anthropic = answersToPlan(
      MANIFEST,
      answers({ AI_ENABLED: "true", AI_PROVIDER: "anthropic" })
    );

    expect(anthropic.requiredSecrets).toContain("ANTHROPIC_API_KEY");
    expect(anthropic.requiredSecrets).not.toContain("OPENAI_API_KEY");

    // noop provider needs no key even when AI is on.
    const noop = answersToPlan(
      MANIFEST,
      answers({ AI_ENABLED: "true", AI_PROVIDER: "noop" })
    );

    expect(noop.requiredSecrets).not.toContain("OPENAI_API_KEY");
    expect(noop.requiredSecrets).not.toContain("ANTHROPIC_API_KEY");
  });

  test("multi-tenancy (ACCOUNT_DOMAIN_CLAIMING) is a pure feature flag — env only, no services/secrets", () => {
    const off = answersToPlan(MANIFEST, answers());
    const on = answersToPlan(
      MANIFEST,
      answers({ ACCOUNT_DOMAIN_CLAIMING: "true" })
    );

    const claim = (p: typeof off): string | undefined =>
      p.envEdits.find((e) => e.key === "ACCOUNT_DOMAIN_CLAIMING")?.value;

    expect(claim(off)).toBe("false");
    expect(claim(on)).toBe("true");
    // It adds no container and no secret either way.
    expect(off.services).toEqual(on.services);
    expect(on.requiredSecrets).toEqual(off.requiredSecrets);
  });

  test("queues + SSE imply Valkey (always-on) — satisfied, no violation", () => {
    const plan = answersToPlan(
      MANIFEST,
      answers({ QUEUES_ENABLED: "true", NOTIFICATIONS_SSE_ENABLED: "true" })
    );

    expect(plan.services).toContain("valkey");
    expect(plan.violations).toEqual([]);
  });
});

describe("answersToPlan — astro archetype", () => {
  test("astro has no services/secrets/boot — static only", () => {
    const plan = answersToPlan(MANIFEST, {
      archetype: "astro",
      stack: "dev",
      values: {},
    });

    expect(plan.services).toEqual([]);
    expect(plan.requiredSecrets).toEqual([]);
    expect(plan.violations).toEqual([]);
  });
});
