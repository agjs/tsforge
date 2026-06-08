// tsforge's bundled strict config for WEB stacks (React/Vue/Svelte via Vite).
// Like strict.eslint.config.mjs, it ENFORCES `I`-prefixed interfaces (project
// house style — `IIssue`, `IButtonProps`), with ONE exemption: library module-
// augmentation interfaces whose name the library dictates and you cannot rename
// (e.g. TanStack Router's `interface Register`). Differs from the core config in
// one other way: it allows `as const` (banning only value-changing `as`/`<Foo>`
// via AST selectors), since `as const` is idiomatic for typed literal registries.
import tseslint from "typescript-eslint";

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

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/build/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      boringstack: { rules: { "one-component-per-file": oneComponentPerFile } },
    },
    rules: {
      // NOTE: we do NOT use `consistent-type-assertions: never` here — that also
      // bans `as const`, which is idiomatic and the cleanest escape for typed
      // literal/tuple data (and it makes a fixed array a tuple, so literal-index
      // access is defined, not `T | undefined`). Instead we ban only the
      // value-changing forms (`x as Foo`, `<Foo>x`) via AST selectors below.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      // I-prefixed interfaces (house style), EXCEPT library-mandated augmentation
      // names you cannot rename (TanStack Router's `interface Register`).
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "interface",
          format: ["PascalCase"],
          prefix: ["I"],
          filter: { regex: "^(Register)$", match: false },
        },
      ],
      // ONE React component per .tsx file (boringstack). Enforced by the custom
      // rule defined above — eslint-plugin-react/no-multi-comp crashes on ESLint 10
      // and @eslint-react has no equivalent, so we ship our own.
      "boringstack/one-component-per-file": "error",
      "prefer-const": "error",
      "prefer-template": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
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
    },
  }
);
