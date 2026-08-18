import { test, expect } from "bun:test";
import {
  ruleHelp,
  ruleHelpFromOutput,
  parseRuleMdx,
} from "../src/loop/feedback/rule-docs";
import generatedDocs from "../src/loop/feedback/rule-docs.generated.json";
import { RULE_PACKS } from "../src/rule-packs";

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

test("ruleHelp renders the exemplar pointer when given one, omits it otherwise", () => {
  const errors = [
    {
      key: "a.ts:1:tsforge/no-bare-date-now",
      file: "a.ts",
      line: 1,
      rule: "tsforge/no-bare-date-now",
      message: "Direct `new Date()` (no args) is non-deterministic.",
    },
  ];
  const withPointer = ruleHelp(
    errors,
    new Map([["tsforge/no-bare-date-now", "src/lib/time.ts (exports now())"]])
  );

  expect(withPointer).toContain(
    "→ existing example in this project: src/lib/time.ts (exports now())"
  );

  expect(ruleHelp(errors)).not.toContain("existing example");
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

test("gives the concrete split procedure for module-boundaries/single-semantic-module", () => {
  // A live build oscillated here: once the full message surfaced (multi-line fix),
  // the model saw the categories but not HOW to split — this card gives the fix.
  const h = ruleHelp([
    {
      key: "k",
      rule: "module-boundaries/single-semantic-module",
      message: "Mixed semantic categories detected in module: - type - schema",
    },
  ]);

  expect(h).toContain("module-boundaries/single-semantic-module");
  expect(h.toLowerCase()).toContain("one concern");
  // The actionable split procedure, not just "don't mix".
  expect(h).toContain("*.types.ts");
  expect(h).toContain("*.schemas.ts");
  expect(h.toLowerCase()).toContain("move");
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

test("ruleHelp: curated AI-SDK rules surface a worked ✗/✓ example", () => {
  const h = ruleHelp([
    { key: "k", rule: "tsforge/require-completion-token-limit", message: "" },
  ]);

  expect(h).toContain("tsforge/require-completion-token-limit");
  expect(h).toContain("✗");
  expect(h).toContain("✓");
  expect(h).toContain("maxTokens");
});

test("ruleHelp: knip/unused-files gets the delete/mirrored fix on the FIRST red gate", () => {
  const h = ruleHelp([
    {
      key: "knip:unused-file:apps/api/src/api/note/note.service.test.ts",
      rule: "knip/unused-files",
      message: "unused file",
    },
  ]);

  expect(h).toContain("knip/unused-files");
  // The way out of the trap: delete the co-located test, use the mirrored tests/ path.
  expect(h.toLowerCase()).toContain("delete");
  expect(h).toContain("mirrored");
});

test("ruleHelp: implicit-any no-unsafe rule shows the validate-the-boundary fix", () => {
  const h = ruleHelp([
    {
      key: "k",
      rule: "@typescript-eslint/no-unsafe-member-access",
      message: "",
    },
  ]);

  expect(h).toContain("✗");
  expect(h).toContain("✓");
});

test("ruleHelp: architecture rule with procedure surfaces fix steps", () => {
  const h = ruleHelp([
    { key: "k", rule: "tsforge/component-folder-structure", message: "" },
  ]);

  expect(h).toContain("tsforge/component-folder-structure");
  expect(h).toContain("procedure:");
  expect(h).toContain("Component.hooks.ts");
});

test("ruleHelp: never emits a `see:` reference line (paths dangle in user projects)", () => {
  // component-folder-structure carries a `reference` — it's a maintainer note,
  // not model feedback: the tsforge-repo-relative path doesn't exist in the
  // user's project, so pointing the model at it wastes a repair turn.
  const h = ruleHelp([
    { key: "k", rule: "tsforge/component-folder-structure", message: "" },
  ]);

  expect(h).not.toContain("see:");
  expect(h).not.toContain("packages/core/src/rule-packs/");
});

test("ruleHelp: every multi-step architecture rule carries a fix procedure", () => {
  // The opinionated-profile rules whose fix is structural (move files, split
  // modules) — a bad/good pair alone can't teach the choreography.
  const rules = [
    "tsforge/component-folder-structure",
    "tsforge/no-state-in-component-body",
    "tsforge/no-inline-jsx-functions",
    "tsforge/index-must-reexport-default",
    "tsforge/max-hooks-per-file",
  ];

  for (const rule of rules) {
    const h = ruleHelp([{ key: "k", rule, message: "" }]);

    expect(h).toContain(rule);
    expect(h).toContain("procedure:");
  }
});

test("ruleHelp: i18n-locale-keys-used steers WIRE-UP, never delete-what-you-wrote", () => {
  const h = ruleHelp([
    { key: "k", rule: "i18n-locale-keys-used", message: "" },
  ]);

  expect(h).toContain("i18n-locale-keys-used");
  // Must carry the constructive procedure…
  expect(h).toContain("procedure:");
  expect(h.toLowerCase()).toContain("wire it up");
  // …and explicitly forbid deleting a translation the model just wrote (aligned
  // with the hard guard: deletion is reverted, not the fix).
  expect(h.toLowerCase()).toContain("do not delete");
  expect(h.toLowerCase()).toContain("not the fix");
});

test("ruleHelp: a pack rule with no worked example shows only its description (no fake ✗/✓)", () => {
  // A rule whose fix is structural carries a procedure INSTEAD of an example —
  // a fabricated ✗/✓ is worse than none, which is how one doc came to promise
  // an "allowlisted URL builder" the rule never had. Moving a file cannot be
  // shown as a same-file before/after, so this rule stays procedure-only.
  // (job-name-must-be-constant and fetch-must-check-ok used to sit here; both
  // now ship verified examples of their own.)
  const h = ruleHelp([
    { key: "k", rule: "tsforge/test-file-mirrors-source", message: "" },
  ]);

  expect(h).toContain("tsforge/test-file-mirrors-source");
  expect(h).toContain("procedure:");
  expect(h).not.toContain("✗");
  expect(h).not.toContain("✓");
});

test("generated docs the reader imports include the tsforge pack rules (guards the write→read path)", () => {
  // The builder must write next to THIS reader. If it drifts to a sibling path,
  // the imported file reverts to zero tsforge rules and generated feedback goes
  // dead at runtime (a rule with no curated card would show empty examples).
  const keys = Object.keys(generatedDocs);
  const tsforgeKeys = keys.filter((k) => k.startsWith("tsforge/"));

  expect(tsforgeKeys.length).toBeGreaterThan(50);
  expect(keys).toContain("tsforge/component-folder-structure");
});

test("ruleHelp: a multi-line example keeps its indentation under the marker", () => {
  // Model-facing formatting: left-flushing continuation lines destroys the
  // snippet's own structure and makes a multi-statement fix hard to read.
  const h = ruleHelp([
    { key: "k", rule: "tsforge/logger-not-console", message: "" },
  ]);
  const lines = h.split("\n");
  const markerAt = lines.findIndex((l) => l.includes("✗"));

  expect(markerAt).toBeGreaterThan(-1);

  const continuation = lines[markerAt + 1];

  expect(continuation).toBeDefined();
  expect(continuation?.startsWith("    ")).toBe(true);
});

test("ruleHelp: test-only metadata never reaches the model", () => {
  // exampleFile / goodFile / exampleIsProse / fixIsDirective exist so the
  // verification test can lint path-sensitive examples. Like `reference`, they
  // are maintainer data: a tsforge-relative path dangles in the user's project
  // and would waste a repair turn.
  const h = ruleHelp(
    Object.values(RULE_PACKS).flatMap((pack) =>
      Object.keys(pack.rules).map((rule) => ({
        key: rule,
        rule: `tsforge/${rule}`,
        message: "",
      }))
    )
  );

  expect(h).not.toContain("exampleFile");
  expect(h).not.toContain("goodFile");
  expect(h).not.toContain("exampleIsProse");
  expect(h).not.toContain("fixIsDirective");
  expect(h).not.toContain("fixIsRelocation");
  expect(h).not.toContain("src/example.ts");
  expect(h).not.toContain("packages/core");
});

test("ruleHelpFromOutput: recovers pack docs from PLAIN eslint text", () => {
  // The path the MODEL takes when it runs the gate itself via the `run` tool.
  // Before this, only TS codes, JSON ruleId fields and @typescript-eslint ids
  // were matched, so the entire tsforge catalogue was invisible here — the model
  // saw a bare rule id and went looking for the answer in the harness source.
  const plain = [
    "/app/src/api.ts",
    "  12:3  error  HTTP request URL must have a fixed origin  tsforge/no-user-controlled-fetch-url",
    "  20:1  error  console in a service                       tsforge/logger-not-console",
  ].join("\n");

  const h = ruleHelpFromOutput(plain);

  expect(h).toContain("tsforge/no-user-controlled-fetch-url");
  expect(h).toContain("tsforge/logger-not-console");
  // and it carries the worked example, not just the id
  expect(h).toContain("✓");
});

test("ruleHelpFromOutput: still recovers TS codes and eslint-core ids", () => {
  const h = ruleHelpFromOutput(
    "error TS2532: Object is possibly undefined\n  @typescript-eslint/no-explicit-any"
  );

  expect(h).toContain("TS2532");
  expect(h).toContain("@typescript-eslint/no-explicit-any");
});

test("ruleHelpFromOutput: a file path is never mistaken for a rule id", () => {
  // `/app/src/api.ts` contains `app/src` and `src/api`, both rule-id shaped.
  // Only the real id on the line should pull guidance.
  const h = ruleHelpFromOutput(
    "/app/src/api.ts\n  12:3  error  Something  tsforge/no-unsafe-boundary-cast"
  );

  expect(h).toContain("tsforge/no-unsafe-boundary-cast");
  expect(h).not.toContain("app/src");
  expect(h).not.toContain("src/api");
});

test("ruleHelp: an example written with a leading newline shows no blank line", () => {
  // Several pack docs are template literals that open with a newline. Indenting
  // that empty line puts the snippet a row below its marker behind stray
  // whitespace, which reads as part of the example.
  const h = ruleHelp([
    { key: "k", rule: "tsforge/auth-cookie-must-be-httponly", message: "" },
  ]);

  expect(h).not.toMatch(/✗\s*\n\s*\n/u);
  expect(h).not.toMatch(/✗ *\n/u);
});
