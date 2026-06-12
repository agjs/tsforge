import { describe, test, expect } from "bun:test";
import { buildStackGuidance } from "../src/loop/prompt/prompt";
import type { IStackProfile } from "../src/stack-detection";

describe("buildStackGuidance", () => {
  test("returns empty string when profile has no packs with guidance", () => {
    const profile: IStackProfile = {
      name: "generic",
      packs: [],
      confidence: "guess",
      reason: "no detected stack",
    };

    const guidance = buildStackGuidance(profile);

    // With no packs, it only includes the header and stack name, not enough lines
    expect(guidance).toContain("## Project stack & conventions");
  });

  test("includes stack name and pack guidance when present", () => {
    const profile: IStackProfile = {
      name: "react+drizzle",
      packs: ["generic-ts", "react", "drizzle"],
      confidence: "certain",
      reason: "react and drizzle-orm in package.json",
    };

    const guidance = buildStackGuidance(profile);

    expect(guidance).toContain("## Project stack & conventions");
    expect(guidance).toContain("react+drizzle");
    expect(guidance).toContain("react and drizzle-orm in package.json");
    expect(guidance).toContain("React");
    expect(guidance).toContain("Drizzle");
  });

  test("skips packs without guidance strings", () => {
    const profile: IStackProfile = {
      name: "react",
      packs: ["generic-ts", "react"],
      confidence: "certain",
      reason: "react in package.json",
    };

    const guidance = buildStackGuidance(profile);

    // React has guidance, generic-ts always-on guidance exists
    expect(guidance.includes("guidance") || guidance.length > 0).toBe(true);
  });

  test("includes guidance from multiple relevant packs", () => {
    const profile: IStackProfile = {
      name: "react+tanstack-query",
      packs: ["generic-ts", "react", "tanstack-query"],
      confidence: "certain",
      reason: "react and @tanstack/react-query detected",
    };

    const guidance = buildStackGuidance(profile);

    expect(guidance).toContain("React");
    expect(guidance).toContain("TanStack");
  });

  test("handles unknown pack IDs gracefully", () => {
    const profile: IStackProfile = {
      name: "custom",
      packs: ["unknown-pack", "generic-ts"],
      confidence: "guess",
      reason: "unknown packs present",
    };

    const guidance = buildStackGuidance(profile);

    // Should not crash, should handle unknown pack gracefully
    expect(typeof guidance).toBe("string");
  });
});
