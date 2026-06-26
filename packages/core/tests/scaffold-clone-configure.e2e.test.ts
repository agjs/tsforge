import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "../src/scaffold/boringstack-manifest";
import { answersToPlan } from "../src/scaffold/plan";
import { cloneRepo } from "../src/scaffold/clone";
import { applyScaffold } from "../src/scaffold/configure";
import { realRunner, realFs } from "../src/scaffold/io";

// REAL clone + configure against an actual BoringStack checkout — OPT-IN
// (TSFORGE_SCAFFOLD_E2E=1) and only when a local clone exists. It runs git +
// BoringStack's real setup.sh (no Docker boot), so it's slow and environment-
// dependent; the unit tests cover the logic deterministically with faked deps.
// This proves the I/O layer against the real repo: shallow clone, sha resolve,
// setup.sh bootstrap, and per-file env writes seeded from .example.
const repo = process.env.BORINGSTACK_REPO ?? "/agjs/code/boringstack";
const enabled =
  process.env.TSFORGE_SCAFFOLD_E2E === "1" &&
  existsSync(join(repo, "setup.sh"));
const e2eTest = enabled ? test : test.skip;

const MANIFEST = parseManifest(
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
      "utf8"
    )
  )
);

e2eTest(
  "clones BoringStack and configures the .env files via its own setup.sh",
  async () => {
    const dest = mkdtempSync(join(tmpdir(), "tsforge-scaffold-e2e-"));

    try {
      const { resolvedSha } = await cloneRepo(repo, "main", dest, realRunner);

      expect(resolvedSha).toMatch(/^[0-9a-f]{40}$/u);

      const plan = answersToPlan(MANIFEST, {
        archetype: "boringstack",
        stack: "dev",
        values: {
          WITH_OBSERVABILITY: "0",
          WITH_GLITCHTIP: "0",
          EMAIL_PROVIDER: "resend",
        },
      });
      const result = await applyScaffold(dest, MANIFEST, plan, {
        run: realRunner,
        fs: realFs,
      });

      // setup.sh ran and bootstrapped compose/.env (+ generated GlitchTip secret).
      const compose = readFileSync(
        join(dest, "infra/compose/compose/.env"),
        "utf8"
      );

      expect(compose).toContain("WITH_OBSERVABILITY=0");
      expect(compose).toMatch(/^GLITCHTIP_SECRET_KEY=.+/mu);
      // Documentation comments survive the edit.
      expect(compose).toContain("# ");

      // App feature landed in the compose api env file.
      const apiEnv = readFileSync(
        join(dest, "infra/compose/compose/api.dev.env"),
        "utf8"
      );

      expect(apiEnv).toContain("EMAIL_PROVIDER=resend");
      expect(result.filesWritten).toContain("infra/compose/compose/.env");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  },
  120_000
);
