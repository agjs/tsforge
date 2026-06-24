import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "../src/scaffold/boringstack-manifest";
import { envKeysOf, coverageGaps } from "../src/scaffold/env-surface";
import type { IScaffoldManifest } from "../src/scaffold";

const MANIFEST: IScaffoldManifest = parseManifest(
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
      "utf8"
    )
  )
);

describe("env-surface completeness alarm", () => {
  test("envKeysOf extracts keys from both live (KEY=) and commented (# KEY=) lines", () => {
    const sample = [
      "STACK=dev",
      "# Disable with WITH_OBSERVABILITY=0.",
      "# WITH_GLITCHTIP=0",
      "POSTGRES_USER=app",
      "# just prose, no key here",
    ].join("\n");

    const keys = envKeysOf(sample);

    expect(keys).toContain("STACK");
    expect(keys).toContain("WITH_OBSERVABILITY");
    expect(keys).toContain("WITH_GLITCHTIP");
    expect(keys).toContain("POSTGRES_USER");
  });

  test("FAILS (reports a gap) when a real toggle/secret is NOT covered by the manifest", () => {
    // Simulate boringstack adding a new configurable the manifest doesn't model.
    const surface = "STACK=dev\n# Enable with WITH_NEWFANGLED_FEATURE=1\n";
    const gaps = coverageGaps(MANIFEST, surface);

    expect(gaps).toContain("WITH_NEWFANGLED_FEATURE");
  });

  test("does NOT flag keys the manifest already covers, nor non-config noise", () => {
    const surface = [
      "STACK=dev",
      "# WITH_OBSERVABILITY=0",
      "# WITH_GLITCHTIP=0",
      "WITH_MAILPIT=1",
      "BILLING_ENABLED=false",
      "EMAIL_PROVIDER=cloudflare",
      "JWT_SECRET=",
      // secrets the manifest reaches via requiresSecrets (conditional) are covered too
      "STRIPE_SECRET_KEY=",
      "RESEND_API_KEY=",
    ].join("\n");

    const gaps = coverageGaps(MANIFEST, surface);

    expect(gaps).toEqual([]);
  });
});

describe("manifest covers the real boringstack env surface", () => {
  // Snapshot of boringstack's actual .env.example files (ref 92c969d). The gated
  // E2E re-runs this against a live clone; this fast unit test is the day-to-day
  // drift guard — if boringstack adds a watched toggle, this FAILS until the
  // manifest models it (or explicitly waives it via watchIgnore).
  const envDir = join(import.meta.dir, "fixtures/scaffold/boringstack-env");
  const combined = [
    "compose.env.example",
    "api.dev.env.example",
    "api.env.example",
    "ui.env.example",
  ]
    .map((f) => readFileSync(join(envDir, f), "utf8"))
    .join("\n");

  test("no watched toggle/flag in the real env is left unmodelled", () => {
    expect(coverageGaps(MANIFEST, combined)).toEqual([]);
  });

  test("the snapshot really does exercise the watch patterns", () => {
    // Guard against a vacuous pass (e.g. empty fixture): the real surface must
    // contain watched keys for the alarm to have meant anything.
    const watched = envKeysOf(combined).filter((k) =>
      /^WITH_|_ENABLED$/u.test(k)
    );

    expect(watched.length).toBeGreaterThan(5);
  });
});
