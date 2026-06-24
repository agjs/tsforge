import { describe, expect, test } from "bun:test";
import { loadBundledManifest } from "../src/scaffold/boringstack-manifest";
import { scaffoldPreview } from "../src/scaffold/preview";
import type { IScaffoldAnswers } from "../src/scaffold";

const MANIFEST = loadBundledManifest();

function answers(
  values: Record<string, string | readonly string[]> = {},
  archetype: IScaffoldAnswers["archetype"] = "boringstack",
  stack: IScaffoldAnswers["stack"] = "dev"
): IScaffoldAnswers {
  return { archetype, stack, values };
}

describe("scaffoldPreview", () => {
  test("shows the container count + service list so the 5-vs-20 cost is visible", () => {
    const full = scaffoldPreview(MANIFEST, answers());
    const lean = scaffoldPreview(
      MANIFEST,
      answers({
        WITH_OBSERVABILITY: "0",
        WITH_GLITCHTIP: "0",
        WITH_MAILPIT: "0",
        WITH_BULLMQ: "0",
      })
    );

    expect(full).toMatch(/14 services/u);
    expect(full).toContain("grafana");
    expect(lean).toMatch(/5 services/u);
    expect(lean).not.toContain("grafana");
  });

  test("lists the conditional-required secrets the user must supply", () => {
    const preview = scaffoldPreview(
      MANIFEST,
      answers({ BILLING_ENABLED: "true", EMAIL_PROVIDER: "resend" })
    );

    expect(preview).toMatch(/secret/iu);
    expect(preview).toContain("STRIPE_SECRET_KEY");
    expect(preview).toContain("RESEND_API_KEY");
  });

  test("surfaces a cross-rule violation as a blocking warning", () => {
    const preview = scaffoldPreview(
      MANIFEST,
      answers({ EMAIL_PROVIDER: "smtp", WITH_MAILPIT: "0" })
    );

    expect(preview).toMatch(/violation|cannot apply|invalid/iu);
    expect(preview).toMatch(/mailpit/iu);
  });

  test("dev needs no prod-only secrets; prod lists them", () => {
    expect(
      scaffoldPreview(MANIFEST, answers({}, "boringstack", "dev"))
    ).not.toContain("JWT_SECRET");

    const prod = scaffoldPreview(MANIFEST, answers({}, "boringstack", "prod"));

    expect(prod).toContain("JWT_SECRET");
  });

  test("astro preview is a static-site build, no services", () => {
    const preview = scaffoldPreview(MANIFEST, answers({}, "astro"));

    expect(preview).toMatch(/static site|astro/iu);
    expect(preview).not.toMatch(/\d+ services/u);
  });
});
