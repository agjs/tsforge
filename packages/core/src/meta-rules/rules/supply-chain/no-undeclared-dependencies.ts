import { builtinModules } from "node:module";
import type {
  IMetaRule,
  IMetaRuleContext,
  IMetaRuleViolation,
} from "../../meta-rules.types";

/**
 * Every bare `import` must resolve to a DECLARED dependency. A classic AI mistake
 * is importing a package it never added to package.json — it works locally via a
 * hoisted/transitive copy, then breaks on a clean install in CI or for a teammate.
 * We compare each imported package against package.json's declared deps (+ Node
 * builtins, `bun:` specifiers, tsconfig path aliases, and the project's own name).
 */
const IMPORT_FROM = /(?:import|export)[^'"]*?from\s*['"](?<spec>[^'"]+)['"]/gu;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"](?<spec>[^'"]+)['"]\s*\)/gu;
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

/** Bare specifiers (packages), skipping relative/absolute paths. */
function bareSpecifiers(text: string): string[] {
  const out: string[] = [];

  for (const re of [IMPORT_FROM, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;

    for (const m of text.matchAll(re)) {
      const spec = m.groups?.spec;

      if (
        spec !== undefined &&
        !spec.startsWith(".") &&
        !spec.startsWith("/")
      ) {
        out.push(spec);
      }
    }
  }

  return out;
}

/** The package name a specifier belongs to (`@scope/pkg/sub` → `@scope/pkg`). */
function packageName(spec: string): string {
  const parts = spec.split("/");

  if (spec.startsWith("@")) {
    return parts.slice(0, 2).join("/");
  }

  return parts[0] ?? spec;
}

/** Collect declared dependency names from every dependency field. */
function declaredDeps(pkg: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  const fields = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];

  for (const field of fields) {
    const map = pkg?.[field];

    if (typeof map === "object" && map !== null) {
      for (const name of Object.keys(map)) {
        names.add(name);
      }
    }
  }

  return names;
}

/** Read a string-keyed property as `unknown` without surfacing `any`. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }

  const record: Record<string, unknown> = { ...value };

  return record[key];
}

/** tsconfig `compilerOptions.paths` alias prefixes (e.g. `@/*` → `@/`). */
function aliasPrefixes(ctx: IMetaRuleContext): string[] {
  const raw = ctx.readFile("tsconfig.json");

  if (raw === null) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const paths = prop(prop(parsed, "compilerOptions"), "paths");

    if (typeof paths !== "object" || paths === null) {
      return [];
    }

    return Object.keys(paths).map((k) => k.replace(/\*$/u, ""));
  } catch {
    return [];
  }
}

/** True when an import is satisfied without a runtime dep declaration. */
function isAllowed(
  pkg: string,
  spec: string,
  declared: ReadonlySet<string>,
  aliases: readonly string[],
  ownName: string
): boolean {
  if (spec.startsWith("bun:") || pkg === "bun") {
    return true;
  }

  if (NODE_BUILTINS.has(pkg) || NODE_BUILTINS.has(spec)) {
    return true;
  }

  if (pkg === ownName || declared.has(pkg) || declared.has(`@types/${pkg}`)) {
    return true;
  }

  return aliases.some((prefix) => prefix.length > 0 && spec.startsWith(prefix));
}

export const noUndeclaredDependenciesRule: IMetaRule = {
  id: "no-undeclared-dependencies",
  category: "supply-chain",
  description:
    "Every imported package must be declared in package.json — an undeclared import works via hoisting locally but breaks on a clean install.",
  severity: "error",
  run(ctx) {
    if (ctx.packageJson === null) {
      return []; // no manifest to check against
    }

    const declared = declaredDeps(ctx.packageJson);
    const aliases = aliasPrefixes(ctx);
    const ownNameRaw = prop(ctx.packageJson, "name");
    const ownName = typeof ownNameRaw === "string" ? ownNameRaw : "";
    const violations: IMetaRuleViolation[] = [];
    const seen = new Set<string>();

    for (const file of ctx.sourceFiles) {
      const text = ctx.readFile(file);

      if (text === null) {
        continue;
      }

      for (const spec of bareSpecifiers(text)) {
        const pkg = packageName(spec);
        const key = `${file}::${pkg}`;

        if (isAllowed(pkg, spec, declared, aliases, ownName) || seen.has(key)) {
          continue;
        }

        seen.add(key);
        violations.push({
          file,
          ruleId: "no-undeclared-dependencies",
          severity: "error",
          message: `Imports \`${pkg}\` but it is not in package.json — add it to dependencies (or devDependencies) so a clean install resolves it.`,
        });
      }
    }

    return violations;
  },
};
