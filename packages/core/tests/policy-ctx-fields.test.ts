import { test, expect, describe } from "bun:test";
import { policyCtxFields } from "../src/loop/run";

// The `--policy-mode` CLI flag threads into a headless/one-shot run through this
// helper. Before it took an override the flag was a silent no-op on those paths
// (runOnce/greenfield never passed it), so `policyCtxFields` is the seam that
// makes the documented flag actually apply.

describe("policyCtxFields", () => {
  test("a CLI override wins over the config's policy.mode", () => {
    const fields = policyCtxFields({ mode: "bypassPermissions" }, "plan");

    expect(fields.policyMode).toBe("plan");
  });

  test("no override → the config's policy.mode drives it", () => {
    expect(policyCtxFields({ mode: "acceptEdits" }).policyMode).toBe(
      "acceptEdits"
    );
  });

  test("an override applies even when the config sets no mode", () => {
    const fields = policyCtxFields(undefined, "plan");

    expect(fields.policyMode).toBe("plan");
  });

  test("no override and no config mode → policyMode is omitted", () => {
    expect(policyCtxFields(undefined).policyMode).toBeUndefined();
    expect(policyCtxFields({}).policyMode).toBeUndefined();
  });

  test("rules always come from the config, independent of the mode override", () => {
    const rules = { allow: [], ask: [], deny: [] };
    const fields = policyCtxFields(
      { mode: "default", rules },
      "bypassPermissions"
    );

    expect(fields.policyMode).toBe("bypassPermissions");
    expect(fields.policyRules).toBe(rules);
  });
});
