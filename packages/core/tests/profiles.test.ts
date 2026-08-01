import { test, expect } from "bun:test";
import {
  resolveProfileRuleOverrides,
  STRUCTURE_RULES,
} from "../src/config/profiles";

// Strict-by-default: the layout-AGNOSTIC best practices (no-inline-jsx-functions,
// forwardref-display-name) must NOT be disabled in the default profiles — only the
// STRUCTURE rules (tsforge's specific file/folder layout) are off by default so tsforge
// stays adoptable on an existing repo.
test("default profiles keep quality rules ON and only disable STRUCTURE rules", () => {
  for (const profile of [
    "recommended",
    "strict",
    "frontend",
    "backend",
  ] as const) {
    const overrides = resolveProfileRuleOverrides(profile);

    // Quality best-practices are NOT forced off (they run at their pack default).
    expect(overrides["no-inline-jsx-functions"]).toBeUndefined();
    expect(overrides["forwardref-display-name"]).toBeUndefined();

    // Every STRUCTURE rule (the tsforge-specific layout) IS off by default.
    for (const rule of STRUCTURE_RULES) {
      expect(overrides[rule]).toBe("off");
    }
  }
});

// The opinionated profile (greenfield / opt-in) turns the STRUCTURE rules back ON.
test("opinionated profile enables the STRUCTURE rules", () => {
  const overrides = resolveProfileRuleOverrides("opinionated");

  expect(overrides["component-folder-structure"]).toBe("error");
  expect(overrides["no-state-in-component-body"]).toBe("error");

  // no rule is forced off in opinionated.
  for (const rule of STRUCTURE_RULES) {
    expect(overrides[rule]).not.toBe("off");
  }
});
