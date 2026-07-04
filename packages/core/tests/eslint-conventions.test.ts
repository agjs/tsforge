import { describe, test, expect } from "bun:test";
import {
  applyBundledOverrides,
  conventionRuleEntries,
  parseConventionsEnv,
  PROTECTED_BUNDLED_RULES,
} from "../src/infer-rules/eslint-conventions";
import { resolveConventions } from "../src/infer-rules/conventions";
import type { RuleEntry } from "../src/infer-rules/eslint-conventions.types";
import { isRecord } from "../src/lib/guards";

/** Pull the selector strings out of a `no-restricted-syntax` entry. */
function selectorsOf(entry: RuleEntry | undefined): string[] {
  if (entry === undefined || typeof entry === "string") {
    return [];
  }

  return entry
    .slice(1)
    .flatMap((s) =>
      isRecord(s) && typeof s.selector === "string" ? [s.selector] : []
    );
}

describe("naming-convention from conventions", () => {
  test("i-prefix (core) requires the I prefix", () => {
    const entry = conventionRuleEntries(
      resolveConventions({ interfaces: "i-prefix" }),
      "core"
    )["@typescript-eslint/naming-convention"];

    expect(entry).toEqual([
      "error",
      { selector: "interface", format: ["PascalCase"], prefix: ["I"] },
    ]);
  });

  test("bare-pascal-case drops the prefix", () => {
    const entry = conventionRuleEntries(
      resolveConventions({ interfaces: "bare-pascal-case" }),
      "core"
    )["@typescript-eslint/naming-convention"];

    expect(entry).toEqual([
      "error",
      { selector: "interface", format: ["PascalCase"] },
    ]);
  });

  test("off omits the rule entirely", () => {
    const entries = conventionRuleEntries(
      resolveConventions({ interfaces: "off" }),
      "core"
    );

    expect(entries["@typescript-eslint/naming-convention"]).toBeUndefined();
  });

  test("web surface uses BARE PascalCase — never requires the I-prefix", () => {
    // React/shadcn/TanStack name interfaces `Props`, not `IProps`; the web surface
    // drops the I-prefix (and needs no Register filter — bare PascalCase already
    // permits `Register`). Even an explicit i-prefix convention stays bare on web.
    const entry = conventionRuleEntries(
      resolveConventions({ interfaces: "i-prefix" }),
      "web"
    )["@typescript-eslint/naming-convention"];

    expect(entry).toEqual([
      "error",
      { selector: "interface", format: ["PascalCase"] },
    ]);
  });

  test("core still requires the I-prefix (web change did not leak to core)", () => {
    const entry = conventionRuleEntries(
      resolveConventions({ interfaces: "i-prefix" }),
      "core"
    )["@typescript-eslint/naming-convention"];

    expect(entry).toEqual([
      "error",
      { selector: "interface", format: ["PascalCase"], prefix: ["I"] },
    ]);
  });
});

describe("no-restricted-syntax: enum ban is split from cast bans", () => {
  test("core + enums ban → only the enum selector", () => {
    const entry = conventionRuleEntries(
      resolveConventions({ enums: "ban" }),
      "core"
    )["no-restricted-syntax"];

    expect(selectorsOf(entry)).toEqual(["TSEnumDeclaration"]);
  });

  test("core + enums allow → rule omitted (casts handled elsewhere on core)", () => {
    const entries = conventionRuleEntries(
      resolveConventions({ enums: "allow" }),
      "core"
    );

    expect(entries["no-restricted-syntax"]).toBeUndefined();
  });

  test("web + enums ban → enum AND both cast selectors", () => {
    const entry = conventionRuleEntries(
      resolveConventions({ enums: "ban" }),
      "web"
    )["no-restricted-syntax"];

    expect(selectorsOf(entry)).toEqual([
      "TSEnumDeclaration",
      "TSAsExpression[typeAnnotation.typeName.name!='const']",
      "TSTypeAssertion",
    ]);
  });

  test("SAFETY: web + enums ALLOW still keeps the cast bans", () => {
    const entry = conventionRuleEntries(
      resolveConventions({ enums: "allow" }),
      "web"
    )["no-restricted-syntax"];

    const selectors = selectorsOf(entry);

    expect(selectors).not.toContain("TSEnumDeclaration");
    expect(selectors).toEqual([
      "TSAsExpression[typeAnnotation.typeName.name!='const']",
      "TSTypeAssertion",
    ]);
  });
});

describe("parseConventionsEnv", () => {
  test("undefined → full defaults", () => {
    expect(parseConventionsEnv(undefined)).toEqual(
      resolveConventions(undefined)
    );
  });

  test("partial JSON merges over defaults", () => {
    expect(parseConventionsEnv('{"interfaces":"bare-pascal-case"}')).toEqual(
      resolveConventions({ interfaces: "bare-pascal-case" })
    );
  });

  test("malformed JSON → defaults (never throws)", () => {
    expect(parseConventionsEnv("{not json")).toEqual(
      resolveConventions(undefined)
    );
  });

  test("a null/invalid field FALLS BACK to the default (never loosens it)", () => {
    // `{"interfaces":null}` used to overwrite the house default with null, which
    // dropped the I-prefix naming requirement — a silent loosening. It must now
    // be ignored, leaving the full defaults intact.
    expect(parseConventionsEnv('{"interfaces":null}')).toEqual(
      resolveConventions(undefined)
    );
    expect(parseConventionsEnv('{"enums":"klingon","interfaces":7}')).toEqual(
      resolveConventions(undefined)
    );
    // A valid field still applies even alongside a garbage one.
    expect(
      parseConventionsEnv('{"interfaces":"bare-pascal-case","tests":null}')
    ).toEqual(resolveConventions({ interfaces: "bare-pascal-case" }));
  });
});

describe("applyBundledOverrides protected-rule guard", () => {
  const bundled: Record<string, RuleEntry> = {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-non-null-assertion": "error",
    "no-restricted-syntax": ["error", { selector: "TSEnumDeclaration" }],
    "prefer-template": "error",
    "@stylistic/padding-line-between-statements": ["error", { foo: 1 }],
  };

  test("safety rules cannot be turned off", () => {
    const out = applyBundledOverrides(bundled, {
      "no-explicit-any": "off",
      "no-non-null-assertion": "warn",
      "no-restricted-syntax": "off",
    });

    expect(out["@typescript-eslint/no-explicit-any"]).toBe("error");
    expect(out["@typescript-eslint/no-non-null-assertion"]).toBe("error");
    expect(out["no-restricted-syntax"]).toEqual([
      "error",
      { selector: "TSEnumDeclaration" },
    ]);
  });

  test("non-protected rules can be downgraded (options preserved)", () => {
    const out = applyBundledOverrides(bundled, {
      "prefer-template": "warn",
      "@stylistic/padding-line-between-statements": "warn",
    });

    expect(out["prefer-template"]).toBe("warn");
    expect(out["@stylistic/padding-line-between-statements"]).toEqual([
      "warn",
      { foo: 1 },
    ]);
  });

  test("non-protected rules can be turned off", () => {
    const out = applyBundledOverrides(bundled, { "prefer-template": "off" });

    expect("prefer-template" in out).toBe(false);
  });

  test("no overrides → unchanged copy", () => {
    expect(applyBundledOverrides(bundled, undefined)).toEqual(bundled);
  });

  test("every protected name is in the set", () => {
    expect(
      PROTECTED_BUNDLED_RULES.has("@typescript-eslint/no-explicit-any")
    ).toBe(true);
    expect(PROTECTED_BUNDLED_RULES.has("no-restricted-syntax")).toBe(true);
    expect(PROTECTED_BUNDLED_RULES.has("prefer-template")).toBe(false);
  });
});
