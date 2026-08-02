// tsforge's bundled strict config for WEB stacks (React/Vue/Svelte via Vite).
// Unlike strict.eslint.config.mjs, it does NOT require the `I`-prefix on interfaces:
// the React/shadcn/TanStack ecosystem names interfaces `Props`, not `IProps`, so web
// interfaces need only be PascalCase (bare `ButtonProps` and `IButtonProps` both pass).
// Bare PascalCase also permits library-mandated names (e.g. TanStack's `Register`).
// Differs from the core config in
// one other way: it allows `as const` (banning only value-changing `as`/`<Foo>`
// via AST selectors), since `as const` is idiomatic for typed literal registries.
//
// Stack-aware rule packs are loaded via TSFORGE_PACKS env var (comma-separated
// pack IDs). Rule overrides via TSFORGE_RULE_OVERRIDES (JSON severity map), and
// project CONVENTIONS via TSFORGE_CONVENTIONS (JSON) — the latter rebuilds the
// naming-convention / no-restricted-syntax rule OPTIONS (the single source shared
// with the gate command, the write-time linter, and the prompts).
import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginJsxA11y from "eslint-plugin-jsx-a11y";
import sonarjs from "eslint-plugin-sonarjs";

// Load stack-aware packs if TSFORGE_PACKS env var is set
let packConfig = [];
const packIds = (process.env.TSFORGE_PACKS ?? "").split(",").filter(Boolean);
const isWebStack = packIds.length > 0;
let ruleOverrides = {};

if (process.env.TSFORGE_RULE_OVERRIDES !== undefined) {
  try {
    ruleOverrides = JSON.parse(process.env.TSFORGE_RULE_OVERRIDES);
    if (typeof ruleOverrides !== "object" || ruleOverrides === null) {
      ruleOverrides = {};
    }
  } catch {
    // If parsing fails, silently ignore overrides
  }
}

if (packIds.length > 0) {
  // NO catch here, deliberately — see the note in strict.eslint.config.mjs: a
  // gate that cannot load its rule packs must fail rather than lint as though it
  // had none.
  const { buildEnvPackConfig } = await import("./src/gate/pack-config.ts");
  packConfig = buildEnvPackConfig(["**/*.ts", "**/*.tsx"], ruleOverrides);
}

// Convention-managed rules — default to the web house style (BARE PascalCase
// interfaces + enum ban + the value-changing cast bans) so a failed import NEVER
// drops the cast/enum safety; the builder then rebuilds them from TSFORGE_CONVENTIONS
// (enum ban split from the ALWAYS-on cast bans).
let conventionRules = {
  "@typescript-eslint/naming-convention": [
    "error",
    {
      selector: "interface",
      format: ["PascalCase"],
    },
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector: "TSEnumDeclaration",
      message: "Use 'as const' object literals instead of enums.",
    },
    {
      selector: "TSAsExpression[typeAnnotation.typeName.name!='const']",
      message:
        "No `as` type casts — type it properly (annotate, narrow, or guard). `as const` is allowed.",
    },
    {
      selector: "TSTypeAssertion",
      message:
        "No angle-bracket type assertions — type it properly. `as const` is allowed.",
    },
  ],
};
let applyBundledOverrides = (rules) => rules;

try {
  const conv = await import("./src/infer-rules/eslint-conventions.ts");
  const conventions = conv.parseConventionsEnv(process.env.TSFORGE_CONVENTIONS);
  conventionRules = conv.conventionRuleEntries(conventions, "web");
  applyBundledOverrides = (rules) =>
    conv.applyBundledOverrides(rules, ruleOverrides);
} catch {
  // Keep the hardcoded house-style defaults above.
}

// Custom rule: ONE React component per .tsx file (boringstack). The classic
// eslint-plugin-react/no-multi-comp crashes on ESLint 10 and @eslint-react has no
// equivalent, so we enforce it directly. A "component" = a TOP-LEVEL PascalCase
// `function`, or a `const PascalCase = (…) => …` whose init is a function. This
// excludes TanStack's `const Route = createFileRoute(...)(...)` (init is a call,
// not a function), so a route file's `Route` + its page component is fine.
const oneComponentPerFile = {
  meta: {
    type: "suggestion",
    messages: {
      multi:
        "One component per file (boringstack): '{{name}}' is a second component — move it to its own file.",
    },
  },
  create(context) {
    if (!context.filename.endsWith(".tsx")) {
      return {};
    }

    const isComponentName = (name) => /^[A-Z]/.test(name);
    const isFn = (node) =>
      node?.type === "ArrowFunctionExpression" ||
      node?.type === "FunctionExpression";

    return {
      Program(program) {
        const components = [];

        for (const statement of program.body) {
          const decl =
            statement.type === "ExportNamedDeclaration" &&
            statement.declaration !== null
              ? statement.declaration
              : statement;

          if (
            decl.type === "FunctionDeclaration" &&
            decl.id !== null &&
            isComponentName(decl.id.name)
          ) {
            components.push(decl.id);
          } else if (decl.type === "VariableDeclaration") {
            for (const d of decl.declarations) {
              if (
                d.id.type === "Identifier" &&
                isComponentName(d.id.name) &&
                isFn(d.init)
              ) {
                components.push(d.id);
              }
            }
          }
        }

        for (const id of components.slice(1)) {
          context.report({
            node: id,
            messageId: "multi",
            data: { name: id.name },
          });
        }
      },
    };
  },
};

// Bundled web rules MINUS the two convention-managed ones. NOTE: we do NOT use
// `consistent-type-assertions: never` here — that also bans `as const`, which is
// idiomatic for typed literal/tuple data. Value-changing casts (`x as Foo`,
// `<Foo>x`) are banned via the AST selectors inside the convention-managed
// `no-restricted-syntax` (ALWAYS on, independent of the enum choice).
const webBundledRules = {
  // Concern-mixing / copy-paste ceiling (syntactic — mirrors the core config).
  // cc <= 20 forces decomposition into named helpers; max-depth/max-params are
  // zero-dep ESLint-core complements.
  "sonarjs/cognitive-complexity": ["error", 20],
  "sonarjs/no-identical-functions": "error",
  "max-depth": ["error", 4],
  "max-params": ["error", 4],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-inferrable-types": "error",
  // ONE React component per .tsx file (boringstack). Enforced by the custom
  // rule defined above — eslint-plugin-react/no-multi-comp crashes on ESLint 10
  // and @eslint-react has no equivalent, so we ship our own.
  "boringstack/one-component-per-file": "error",
  "react/jsx-key": "error",
  "react/no-array-index-key": "error",
  "react/button-has-type": "error",
  "react-hooks/rules-of-hooks": "error",
  "react-hooks/exhaustive-deps": "warn",
  "prefer-const": "error",
  "prefer-template": "error",
  "no-var": "error",
  // Blank-line discipline (mirrors the core config) — the model rarely gets
  // spacing right, so prettier --write + this rule's --fix make it free. Uses
  // @stylistic (the rule's maintained home; the core rule is deprecated and
  // spams `usedDeprecatedRules` into eslint's --format json gate output).
  "@stylistic/padding-line-between-statements": [
    "error",
    { blankLine: "always", prev: "import", next: "*" },
    { blankLine: "any", prev: "import", next: "import" },
    { blankLine: "always", prev: "*", next: "return" },
    { blankLine: "always", prev: "*", next: "throw" },
    { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
    {
      blankLine: "any",
      prev: ["const", "let", "var"],
      next: ["const", "let", "var"],
    },
    { blankLine: "always", prev: "block-like", next: "*" },
    { blankLine: "always", prev: "*", next: "block-like" },
  ],
  eqeqeq: ["error", "always"],
  curly: ["error", "all"],
};

// Pack rules win last (they already had TSFORGE_RULE_OVERRIDES applied via
// buildPackEslintConfig), so apply the bundled-override pass only to the bundled +
// convention rules, then layer pack rules on top — unchanged from before.
const rules = {
  ...applyBundledOverrides({ ...webBundledRules, ...conventionRules }),
  ...packConfig.reduce((acc, cfg) => ({ ...acc, ...(cfg.rules ?? {}) }), {}),
};

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "@stylistic": stylistic,
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      sonarjs,
      boringstack: { rules: { "one-component-per-file": oneComponentPerFile } },
      ...packConfig
        .filter(
          (cfg) => cfg.plugins !== undefined && cfg.plugins.tsforge !== undefined
        )
        .reduce((acc, cfg) => ({ ...acc, ...cfg.plugins }), {}),
    },
    rules,
    settings: {
      react: { version: "detect" },
    },
  },
  ...packConfig,
  ...(isWebStack
    ? [
        {
          files: ["**/*.tsx"],
          plugins: { "jsx-a11y": pluginJsxA11y },
          rules: {
            "jsx-a11y/alt-text": "error",
            "jsx-a11y/anchor-is-valid": "warn",
            "jsx-a11y/aria-props": "error",
            "jsx-a11y/click-events-have-key-events": "warn",
            "jsx-a11y/no-static-element-interactions": "warn",
            "jsx-a11y/label-has-associated-control": "error",
            "jsx-a11y/no-noninteractive-tabindex": "error",
          },
        },
      ]
    : [])
);
