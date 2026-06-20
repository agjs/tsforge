import { join } from "node:path";

/**
 * The baseline constitution — the deterministic gate floor tsforge brings to an
 * under-gated TypeScript repo so "correct" has a meaning even where the repo
 * ships none. Mirrors tsforge's OWN gate (strict `tsc` + the boringstack-derived
 * eslint house rules + prettier), so a target fails the same way tsforge does.
 *
 * Bringing it is NON-DESTRUCTIVE: a repo's own config for a tool is authority,
 * and we only write a file when nothing equivalent exists. We never install
 * dependencies — `dependencies` lists what the written configs need so the
 * caller can ensure them separately.
 */

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,

    "strict": true,
    "useUnknownInCatchVariables": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,

    "skipLibCheck": true
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules", "dist", "scratch"]
}
`;

const PRETTIER = `{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": false,
  "printWidth": 80,
  "tabWidth": 2
}
`;

// This is the BROWNFIELD floor written into a target repo's own eslint.config.js
// (a serialized source string, not an in-memory config). Its interface-naming +
// no-enum rules below encode the DEFAULT conventions (I-prefix, enum ban) — the
// same values infer-rules/conventions DEFAULT_CONVENTIONS produces. The live gate,
// the write-time linter, and the prompts read project conventions DYNAMICALLY
// (TSFORGE_CONVENTIONS); this brought floor intentionally uses the defaults for
// V1 (per the setup plan: honoring per-repo conventions here is secondary to a
// drift-free runtime). Changing DEFAULT_CONVENTIONS trips the conventions tests,
// which is the reminder to revisit this block.
const ESLINT = `import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import configPrettier from "eslint-config-prettier";
import pluginPrettier from "eslint-plugin-prettier";

// Brought by tsforge: the general TypeScript quality rules (type-safety, async
// correctness, strict-boolean, I-prefixed interfaces, no-enum, prettier). Every
// rule is \`error\` — local green == CI green. Delete or relax in your own config.
export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      pluginJs.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      configPrettier,
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      prettier: pluginPrettier,
    },
    rules: {
      "prettier/prettier": "error",

      // Idiomatic-output rules promoted to the GATE: over-annotation and
      // string concatenation become deterministic errors, not reviewer notes.
      "@typescript-eslint/no-inferrable-types": "error",
      "prefer-template": "error",

      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],

      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: true,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],

      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "interface", format: ["PascalCase"], prefix: ["I"] },
        { selector: "typeAlias", format: ["PascalCase"] },
        { selector: "typeParameter", format: ["PascalCase"] },
        {
          selector: "variable",
          format: ["camelCase", "UPPER_CASE", "PascalCase"],
          leadingUnderscore: "allow",
        },
        { selector: "function", format: ["camelCase", "PascalCase"] },
        { selector: ["objectLiteralProperty", "typeProperty"], format: null },
      ],

      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-var": "error",
      "prefer-const": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use 'as const' object literals instead of enums.",
        },
      ],
    },
  }
);
`;

interface IBaselineFile {
  /** The file we write when nothing equivalent is present. */
  path: string;
  /** Any of these existing means the repo already has this tool's config. */
  satisfiedBy: string[];
  content: string;
}

const FILES: IBaselineFile[] = [
  { path: "tsconfig.json", satisfiedBy: ["tsconfig.json"], content: TSCONFIG },
  {
    path: "eslint.config.js",
    satisfiedBy: [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
    ],
    content: ESLINT,
  },
  {
    path: ".prettierrc.json",
    satisfiedBy: [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.js",
      ".prettierrc.cjs",
      "prettier.config.js",
      "prettier.config.mjs",
    ],
    content: PRETTIER,
  },
];

/** What the brought configs need installed (we never install them ourselves). */
const DEPENDENCIES = [
  "typescript",
  "@eslint/js",
  "eslint",
  "typescript-eslint",
  "eslint-config-prettier",
  "eslint-plugin-prettier",
  "prettier",
];

export interface IConstitutionState {
  tsconfig: boolean;
  eslint: boolean;
  prettier: boolean;
}

export interface IBroughtConstitution {
  /** Config files written (were absent). */
  written: string[];
  /** Config files left alone (the repo already had one). */
  skipped: string[];
  /** npm dependencies the written configs require. */
  dependencies: string[];
  /** The gate command that runs the constitution. */
  verify: string;
}

export interface IBringOptions {
  /** Test command appended to the gate (default `bun test`). */
  testCommand?: string;
}

/** Report which parts of the constitution the repo already has — writes nothing. */
export async function analyzeConstitution(
  cwd: string
): Promise<IConstitutionState> {
  return {
    tsconfig: await anyExists(cwd, FILES[0]?.satisfiedBy ?? []),
    eslint: await anyExists(cwd, FILES[1]?.satisfiedBy ?? []),
    prettier: await anyExists(cwd, FILES[2]?.satisfiedBy ?? []),
  };
}

/** Materialize the missing parts of the gate floor into `cwd`, non-destructively. */
export async function bringConstitution(
  cwd: string,
  opts: IBringOptions = {}
): Promise<IBroughtConstitution> {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of FILES) {
    if (await anyExists(cwd, file.satisfiedBy)) {
      skipped.push(file.path);
      continue;
    }

    await Bun.write(join(cwd, file.path), file.content);
    written.push(file.path);
  }

  const testCommand = opts.testCommand ?? "bun test";
  const verify = [
    "tsc --noEmit -p tsconfig.json",
    "eslint .",
    'prettier --check "**/*.{ts,tsx}"',
    testCommand,
  ].join(" && ");

  return { written, skipped, dependencies: DEPENDENCIES, verify };
}

async function anyExists(cwd: string, names: string[]): Promise<boolean> {
  for (const name of names) {
    if (await Bun.file(join(cwd, name)).exists()) {
      return true;
    }
  }

  return false;
}
