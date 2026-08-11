import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

/**
 * Detect if a file is a candidate component module (.tsx, not test/story).
 * Structure/hooks rules apply when the file declares a top-level PascalCase
 * component (see {@link isComponentDeclaration}) — including kebab basenames
 * like `feed-page.tsx` exporting `FeedPage`. Path-only PascalCase checks are
 * insufficient for Vite greenfield layouts.
 */
export function isComponentFile(filename: string): boolean {
  if (!filename.endsWith(".tsx")) {
    return false;
  }

  if (filename.includes(".test.tsx") || filename.includes(".stories.tsx")) {
    return false;
  }

  return true;
}

/**
 * True when the basename is PascalCase (Button.tsx). Prefer declaration checks
 * for kebab feature files.
 */
export function hasPascalCaseComponentBasename(filename: string): boolean {
  return /^[A-Z]/.test(getBasename(filename));
}

/**
 * Detect if a file is a story file
 */
export function isStoryFile(filename: string): boolean {
  return filename.includes(".stories.tsx");
}

/**
 * Detect if a file is a test file
 */
export function isTestFile(filename: string): boolean {
  return filename.includes(".test.ts") || filename.includes(".test.tsx");
}

/**
 * True when a function returns JSX directly or via a block `return`.
 */
export function isJsxReturningFunction(
  node: TSESTree.FunctionDeclaration | TSESTree.ArrowFunctionExpression
): boolean {
  const fnBody = node.body;

  if (!fnBody) {
    return false;
  }

  if (
    fnBody.type === AST_NODE_TYPES.JSXElement ||
    fnBody.type === AST_NODE_TYPES.JSXFragment
  ) {
    return true;
  }

  if (fnBody.type === AST_NODE_TYPES.BlockStatement) {
    return containsReturnOfJsx(fnBody);
  }

  return false;
}

function containsReturnOfJsx(block: TSESTree.BlockStatement): boolean {
  for (const stmt of block.body) {
    if (stmt.type === AST_NODE_TYPES.ReturnStatement) {
      const arg = stmt.argument;

      if (
        arg &&
        (arg.type === AST_NODE_TYPES.JSXElement ||
          arg.type === AST_NODE_TYPES.JSXFragment)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Detect if path is in shadcn/ui components folder
 */
export function isInShadcnUi(filename: string): boolean {
  return filename.includes("/components/ui/");
}

/**
 * Detect if a path is a TanStack route file (generated/hand-wired shells under
 * src/routes/). These legitimately hold a non-component `const Route =
 * createFileRoute(...)` and are exempt from the component-purity/location rules.
 */
export function isRouteFile(filename: string): boolean {
  return /(^|\/)src\/routes\//.test(filename);
}

/** A name is a component name when it is PascalCase (starts with an uppercase). */
export function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** True when a node is a function expression/arrow (a component's init shape). */
function isFunctionInit(node: TSESTree.Expression | null | undefined): boolean {
  return (
    node?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node?.type === AST_NODE_TYPES.FunctionExpression
  );
}

/**
 * Given a top-level statement (already unwrapped from any `export`), report
 * whether it DECLARES a React component — a PascalCase `function`, or a
 * `const PascalCase = (…) => …` whose init is a function. A `const Route =
 * createFileRoute(...)(...)` is NOT a component (its init is a call), so route
 * files don't trip this.
 */
export function isComponentDeclaration(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id !== null) {
    return isComponentName(node.id.name);
  }

  if (node.type === AST_NODE_TYPES.VariableDeclaration) {
    return node.declarations.some(
      (d) =>
        d.id.type === AST_NODE_TYPES.Identifier &&
        isComponentName(d.id.name) &&
        isFunctionInit(d.init)
    );
  }

  return false;
}

/** Unwrap a top-level statement from its `export`/`export default` wrapper, so
 *  callers classify the underlying declaration uniformly. */
export function unwrapExport(
  statement: TSESTree.ProgramStatement
): TSESTree.Node {
  if (
    (statement.type === AST_NODE_TYPES.ExportNamedDeclaration ||
      statement.type === AST_NODE_TYPES.ExportDefaultDeclaration) &&
    statement.declaration !== null
  ) {
    return statement.declaration;
  }

  return statement;
}

/**
 * Extract component name from filename (e.g., Button.tsx → Button).
 * Kebab files return null — callers should take the name from the AST declaration.
 */
export function getComponentName(filename: string): string | null {
  const basename = getBasename(filename);
  const match = /^([A-Z][a-zA-Z0-9]*)\.tsx$/.exec(basename);

  return match ? (match[1] ?? null) : null;
}

/** First PascalCase component name declared at module top level, if any. */
export function componentNameFromProgram(
  program: TSESTree.Program
): string | null {
  for (const statement of program.body) {
    const decl = unwrapExport(statement);

    if (
      decl.type === AST_NODE_TYPES.FunctionDeclaration &&
      decl.id !== null &&
      isComponentName(decl.id.name)
    ) {
      return decl.id.name;
    }

    if (decl.type === AST_NODE_TYPES.VariableDeclaration) {
      for (const d of decl.declarations) {
        if (
          d.id.type === AST_NODE_TYPES.Identifier &&
          isComponentName(d.id.name) &&
          isFunctionInit(d.init)
        ) {
          return d.id.name;
        }
      }
    }
  }

  return null;
}

/** True when the program declares at least one top-level React component. */
export function programDeclaresComponent(program: TSESTree.Program): boolean {
  return componentNameFromProgram(program) !== null;
}

/**
 * Get the basename without directory
 */
function getBasename(filename: string): string {
  return filename.split("/").pop() ?? "";
}
