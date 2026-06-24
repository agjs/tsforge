import { describe, expect, test } from "bun:test";
import { loadBundledManifest } from "../src/scaffold/boringstack-manifest";
import { answersToPlan } from "../src/scaffold/plan";
import type { IScaffoldAnswers } from "../src/scaffold";

const MANIFEST = loadBundledManifest();

function plan(
  values: Record<string, string | readonly string[]>,
  stack: IScaffoldAnswers["stack"] = "dev"
): ReturnType<typeof answersToPlan> {
  return answersToPlan(MANIFEST, { archetype: "boringstack", stack, values });
}

// Each dev-default-on infra toggle and the exact services it owns. The matrix
// asserts BOTH directions: off removes exactly these, and (all-others-off) leaves
// exactly these + the always-on core. This is the "turn every feature on/off" spec.
const TOGGLE_SERVICES: readonly {
  readonly key: string;
  readonly services: readonly string[];
}[] = [
  {
    key: "WITH_OBSERVABILITY",
    services: ["prometheus", "alertmanager", "grafana", "loki", "tempo"],
  },
  { key: "WITH_GLITCHTIP", services: ["glitchtip-web", "glitchtip-worker"] },
  { key: "WITH_MAILPIT", services: ["mailpit"] },
  { key: "WITH_BULLMQ", services: ["bullmq-dashboard"] },
];

const ALWAYS_ON = ["api", "api-migrate", "postgres", "ui", "valkey"];
const ALL_INFRA_OFF = {
  WITH_OBSERVABILITY: "0",
  WITH_GLITCHTIP: "0",
  WITH_MAILPIT: "0",
  WITH_BULLMQ: "0",
} as const;

describe("capability matrix — infra toggle ⇒ exact service set", () => {
  for (const { key, services } of TOGGLE_SERVICES) {
    test(`${key} off removes exactly ${services.join("+")}`, () => {
      const running = new Set(plan({ [key]: "0" }).services);

      for (const svc of services) {
        expect(running.has(svc)).toBe(false);
      }
    });

    test(`${key} is the sole owner of its services`, () => {
      // Everything off except this one → always-on + exactly this toggle's set.
      const only = plan({ ...ALL_INFRA_OFF, [key]: "1" });

      expect([...only.services].sort()).toEqual(
        [...ALWAYS_ON, ...services].sort()
      );
    });
  }

  test("all infra toggles off ⇒ the lean always-on core only", () => {
    expect(plan(ALL_INFRA_OFF).services).toEqual([...ALWAYS_ON].sort());
  });
});

describe("capability matrix — WUD is prod-only", () => {
  test("present in prod by default, absent in dev", () => {
    expect(plan({}, "prod").services).toContain("wud");
    expect(plan({}, "dev").services).not.toContain("wud");
  });

  test("can be disabled in prod", () => {
    expect(plan({ WUD: "0" }, "prod").services).not.toContain("wud");
  });
});

describe("capability matrix — email provider ⇒ exact secrets", () => {
  const cases: readonly {
    readonly provider: string;
    readonly secrets: readonly string[];
  }[] = [
    {
      provider: "cloudflare",
      secrets: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_EMAIL_API_TOKEN"],
    },
    { provider: "resend", secrets: ["RESEND_API_KEY"] },
    { provider: "sendgrid", secrets: ["SENDGRID_API_KEY"] },
    { provider: "smtp", secrets: [] },
  ];
  const allEmailSecrets = cases.flatMap((c) => c.secrets);

  for (const { provider, secrets } of cases) {
    const label = secrets.length > 0 ? secrets.join("+") : "no";

    test(`${provider} requires exactly ${label} secret(s)`, () => {
      const required = new Set(
        plan({ EMAIL_PROVIDER: provider }).requiredSecrets
      );

      for (const s of secrets) {
        expect(required.has(s)).toBe(true);
      }

      // …and none of the OTHER providers' keys.
      for (const other of allEmailSecrets.filter((s) => !secrets.includes(s))) {
        expect(required.has(other)).toBe(false);
      }
    });
  }
});

describe("capability matrix — each OAuth provider ⇒ its own credential pair", () => {
  const providers = ["google", "github", "linkedin"] as const;

  for (const p of providers) {
    test(`${p} requires only its client id + secret`, () => {
      const required = new Set(plan({ OAUTH_PROVIDERS: [p] }).requiredSecrets);
      const up = p.toUpperCase();

      expect(required.has(`${up}_OAUTH_CLIENT_ID`)).toBe(true);
      expect(required.has(`${up}_OAUTH_CLIENT_SECRET`)).toBe(true);

      for (const other of providers.filter((o) => o !== p)) {
        expect(required.has(`${other.toUpperCase()}_OAUTH_CLIENT_ID`)).toBe(
          false
        );
      }
    });
  }
});

describe("capability matrix — tracing + cache choices don't false-alarm", () => {
  test("TRACING_BACKEND sentry/none produce no violation (otel not selected)", () => {
    expect(plan({ TRACING_BACKEND: "sentry" }).violations).toEqual([]);
    expect(plan({ TRACING_BACKEND: "none" }).violations).toEqual([]);
  });

  test("CACHE_PROVIDER memory needs no extra service + no violation", () => {
    const p = plan({ CACHE_PROVIDER: "memory" });

    expect(p.violations).toEqual([]);
    // memory cache doesn't add a service beyond the always-on core
    expect(p.services).toContain("valkey"); // still always-on
  });
});
