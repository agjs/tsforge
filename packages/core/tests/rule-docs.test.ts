import { test, expect } from "bun:test";
import {
  ruleHelp,
  ruleHelpFromOutput,
  parseRuleMdx,
} from "../src/loop/feedback/rule-docs";

const SAMPLE_MDX = `---
description: 'Disallow returning a value with type \`any\` from a function.'
---

import Tabs from '@theme/Tabs';

## Examples

<Tabs>
<TabItem value="❌ Incorrect">

\`\`\`ts
function foo() {
  return 1 as any;
}
\`\`\`

</TabItem>
<TabItem value="✅ Correct">

\`\`\`ts
function foo(): number {
  return 1;
}
\`\`\`

</TabItem>
</Tabs>
`;

test("parseRuleMdx extracts description + incorrect/correct from rule source", () => {
  const doc = parseRuleMdx(SAMPLE_MDX);

  expect(doc).not.toBeNull();
  expect(doc?.what).toContain("Disallow returning");
  expect(doc?.bad).toContain("1 as any");
  expect(doc?.good).toContain("number");
});

test("parseRuleMdx returns null when the sections aren't present", () => {
  expect(parseRuleMdx("just some prose, no examples")).toBeNull();
});

test("ruleHelpFromOutput pulls guidance from raw tsc + eslint-json output", () => {
  const tsc = ruleHelpFromOutput("money.ts(57,7): error TS2532: Object …");

  expect(tsc).toContain("const x = arr[i]");

  const eslint = ruleHelpFromOutput(
    '[{"messages":[{"ruleId":"@typescript-eslint/no-unsafe-return"}]}]'
  );

  expect(eslint.toLowerCase()).toContain("no-unsafe-return");
  expect(ruleHelpFromOutput("all good, exit 0")).toBe("");
});

test("injects tsforge React pack idiom cards keyed by the gate's rule id", () => {
  const jsx = ruleHelp([
    { key: "k", rule: "tsforge/no-jsx-computation", message: "" },
  ]);

  expect(jsx).toContain("tsforge/no-jsx-computation");
  expect(jsx).toContain("useMemo");
});

test("injects React framework idiom cards keyed by the gate's rule id", () => {
  // The knowledge-card prototype: framework idioms ride the SAME failure-keyed
  // mechanism as eslint/TS rules — the gate names the rule, we surface its card.
  const hooks = ruleHelp([
    { key: "k", rule: "react-hooks/rules-of-hooks", message: "" },
  ]);

  expect(hooks).toContain("react-hooks/rules-of-hooks");
  expect(hooks).toContain("useState");

  const key = ruleHelpFromOutput(
    '[{"messages":[{"ruleId":"react/no-array-index-key"}]}]'
  );

  expect(key).toContain("stable id");
});

test("gives the guard idiom (bad/good) for a TS unchecked-index error", () => {
  const h = ruleHelp([
    { key: "k", rule: "TS2532", message: "Object is possibly 'undefined'." },
  ]);

  expect(h).toContain("const x = arr[i]");
  expect(h).toContain("✗");
  expect(h).toContain("✓");
});

test("gives a good/bad example for an eslint rule, keyed by ruleId", () => {
  const h = ruleHelp([
    {
      key: "k",
      rule: "@typescript-eslint/no-unsafe-return",
      message: "Unsafe return of a value of type `any`.",
    },
  ]);

  expect(h.toLowerCase()).toContain("no-unsafe-return");
  expect(h).toContain("✓");
});

test("emits each rule once even with several errors of that rule", () => {
  const h = ruleHelp([
    { key: "a", rule: "TS2532", message: "x" },
    { key: "b", rule: "TS2532", message: "y" },
  ]);

  expect(h.split("const x = arr[i]").length - 1).toBe(1);
});

test("is empty for unknown rules / no errors", () => {
  expect(ruleHelp([{ key: "a", rule: "no-such-rule", message: "x" }])).toBe("");
  expect(ruleHelp([{ key: "a", message: "no rule field" }])).toBe("");
  expect(ruleHelp([])).toBe("");
});
