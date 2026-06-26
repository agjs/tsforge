import { describe, expect, test } from "bun:test";
import {
  applyEnvEdits,
  summarizeEnvEdits,
  type IEnvWrite,
} from "../src/scaffold/configure";

const BASE = [
  "# boringstack environment",
  "STACK=dev",
  "WITH_OBSERVABILITY=1",
  "# Disable Mailpit with WITH_MAILPIT=0",
  "EMAIL_PROVIDER=cloudflare",
  "",
].join("\n");

describe("applyEnvEdits", () => {
  test("replaces an existing live key's value in place", () => {
    const out = applyEnvEdits(BASE, [
      { key: "WITH_OBSERVABILITY", value: "0", secret: false },
    ]);

    expect(out).toContain("WITH_OBSERVABILITY=0");
    expect(out).not.toContain("WITH_OBSERVABILITY=1");
    // The surrounding lines are untouched.
    expect(out).toContain("STACK=dev");
    expect(out).toContain("EMAIL_PROVIDER=cloudflare");
  });

  test("appends a key that is not present", () => {
    const out = applyEnvEdits(BASE, [
      { key: "BILLING_ENABLED", value: "true", secret: false },
    ]);

    expect(out).toContain("BILLING_ENABLED=true");
    expect(out.trimEnd().split("\n").at(-1)).toBe("BILLING_ENABLED=true");
  });

  test("never rewrites a key that only appears inside a comment", () => {
    const out = applyEnvEdits(BASE, [
      { key: "WITH_MAILPIT", value: "0", secret: false },
    ]);

    // The documentation comment is preserved verbatim...
    expect(out).toContain("# Disable Mailpit with WITH_MAILPIT=0");
    // ...and a real assignment is appended (not spliced into the comment).
    const live = out
      .split("\n")
      .filter((l) => l.trimStart().startsWith("WITH_MAILPIT="));

    expect(live).toEqual(["WITH_MAILPIT=0"]);
  });

  test("applies several edits, last-writer-wins per key", () => {
    const edits: readonly IEnvWrite[] = [
      { key: "STACK", value: "prod", secret: false },
      { key: "EMAIL_PROVIDER", value: "resend", secret: false },
      { key: "STACK", value: "smoke", secret: false },
    ];
    const out = applyEnvEdits(BASE, edits);

    expect(out).toContain("STACK=smoke");
    expect(out).not.toContain("STACK=prod");
    expect(out).not.toContain("STACK=dev");
    expect(out).toContain("EMAIL_PROVIDER=resend");
  });

  test("writes a secret's value into the file (the file must be correct)", () => {
    const out = applyEnvEdits(BASE, [
      { key: "JWT_SECRET", value: "s3cr3t-value", secret: true },
    ]);

    expect(out).toContain("JWT_SECRET=s3cr3t-value");
  });
});

describe("summarizeEnvEdits (org rule: secrets never logged)", () => {
  test("redacts secret values but shows non-secret values", () => {
    const lines = summarizeEnvEdits([
      { key: "STACK", value: "dev", secret: false },
      { key: "JWT_SECRET", value: "super-secret-do-not-log", secret: true },
    ]);
    const joined = lines.join("\n");

    expect(joined).toContain("STACK=dev");
    // The secret KEY is shown (so the user knows it was set)...
    expect(joined).toContain("JWT_SECRET");
    // ...but its VALUE never appears anywhere in the summary.
    expect(joined).not.toContain("super-secret-do-not-log");
  });
});
