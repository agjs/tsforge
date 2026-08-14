import { test, expect, describe } from "bun:test";
import { houseConventionProvider } from "../src/loop/conventions";
import {
  withProfileEnforcement,
  enforcementFooter,
} from "../src/loop/conventions/profile-enforcement";
import {
  disabledRulesInProfile,
  STRUCTURE_RULES,
} from "../src/config/profiles";

/**
 * A convention guide must never promise enforcement the ACTIVE profile does not
 * deliver. A real greenfield build ran on the default profile — structure rules
 * off — while the component-anatomy guide claimed "the sibling set the gate
 * requires". The gate passed flat single-file components, so the model concluded
 * the folder layout was optional and the layout drifted.
 */
describe("convention guides tell the truth about the gate", () => {
  test("the default profile disables the structure rules", () => {
    const disabled = disabledRulesInProfile("recommended");

    for (const rule of STRUCTURE_RULES) {
      expect(disabled.has(rule)).toBe(true);
    }
  });

  test("the opinionated profile disables none of them", () => {
    const disabled = disabledRulesInProfile("opinionated");

    for (const rule of STRUCTURE_RULES) {
      expect(disabled.has(rule)).toBe(false);
    }
  });

  test("component-anatomy says folder layout is NOT enforced on the default profile", () => {
    const provider = withProfileEnforcement(
      houseConventionProvider,
      "recommended"
    );
    const guide = provider.guide("component-anatomy") ?? "";

    expect(guide).toContain("component-folder-structure");
    expect(guide).toContain("NOT enforced");
    // And it still names what DOES fail, so the model knows the rest is real.
    expect(guide).toContain("opinionated");
  });

  test("the same guide carries no caveat on the opinionated profile", () => {
    const provider = withProfileEnforcement(
      houseConventionProvider,
      "opinionated"
    );
    const guide = provider.guide("component-anatomy") ?? "";

    expect(guide).not.toContain("NOT enforced");
    expect(guide).toContain("COMPONENT ANATOMY");
  });

  test("the guide text itself never claims the gate requires the sibling set", () => {
    // The base text must stay profile-neutral: only the footer may speak for the
    // gate, because only it knows which profile is running.
    const raw = houseConventionProvider.guide("component-anatomy") ?? "";

    expect(raw).not.toContain("the gate requires");
  });

  test("a topic whose rules are all enforced is passed through untouched", () => {
    const provider = withProfileEnforcement(
      houseConventionProvider,
      "recommended"
    );

    // `testing` rules are not structure rules, so nothing is off for it.
    expect(provider.guide("testing")).toBe(
      houseConventionProvider.guide("testing")
    );
  });

  test("the reactive push after a red gate carries the same caveat", () => {
    const provider = withProfileEnforcement(
      houseConventionProvider,
      "recommended"
    );
    const pushed = provider.unseenForErrors(
      [{ rule: "tsforge/component-folder-structure" }],
      new Set()
    );

    expect(pushed).toHaveLength(1);
    expect(pushed[0] ?? "").toContain("NOT enforced");
  });

  test("push annotates each guide with ITS OWN topic, not the first one", () => {
    const provider = withProfileEnforcement(
      houseConventionProvider,
      "recommended"
    );
    const pushed = provider.unseenForErrors(
      [
        { rule: "tsforge/test-sibling-required" },
        { rule: "tsforge/component-folder-structure" },
      ],
      new Set()
    );

    expect(pushed).toHaveLength(2);
    // testing → fully enforced, no caveat; component-anatomy → caveat.
    expect(pushed[0] ?? "").toContain("TESTING");
    expect(pushed[0] ?? "").not.toContain("NOT enforced");
    expect(pushed[1] ?? "").toContain("COMPONENT ANATOMY");
    expect(pushed[1] ?? "").toContain("NOT enforced");
  });

  test("the footer names every disabled rule, not just the first", () => {
    const footer =
      enforcementFooter(["a", "b", "c"], new Set(["a", "c"])) ?? "";

    expect(footer).toContain("a, c");
    expect(footer).toContain("are NOT enforced");
    expect(footer).toContain("The gate DOES fail on: b.");
  });

  test("a fully disabled topic says so rather than naming an empty enforced set", () => {
    const footer = enforcementFooter(["a"], new Set(["a"])) ?? "";

    expect(footer).toContain("is NOT enforced");
    expect(footer).toContain("fails on none");
  });
});
