import type { TSESTree } from "@typescript-eslint/utils";

/** True if the file lives under a Next.js app-router directory (an `app` segment). */
export function isAppRouterFile(filename: string): boolean {
  return filename.split(/[\\/]/).includes("app");
}

/** True if the file is an app-router route-entry file (page/layout/template),
 *  which default to React Server Components. */
export function isRouteEntryFile(filename: string): boolean {
  const base = filename.split(/[\\/]/).pop() ?? "";

  return /^(?:page|layout|template)\.(?:tsx|ts|jsx|js)$/.test(base);
}

/** True if the program's directive prologue contains `directive`
 *  (e.g. "use client" / "use server"). */
export function hasDirective(
  program: TSESTree.Program,
  directive: string
): boolean {
  for (const stmt of program.body) {
    if (
      stmt.type !== "ExpressionStatement" ||
      stmt.expression.type !== "Literal" ||
      typeof stmt.expression.value !== "string"
    ) {
      return false; // directive prologue has ended
    }

    if (stmt.expression.value === directive) {
      return true;
    }
  }

  return false;
}

/** Resolve a call's callee to a simple name: `useState` or `React.useState`
 *  → "useState". Returns null for computed or complex callees. */
export function calleeName(callee: TSESTree.Node): string | null {
  if (callee.type === "Identifier") {
    return callee.name;
  }

  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }

  return null;
}
