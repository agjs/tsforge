import { relative, dirname, join } from "node:path";
import ts from "typescript";
import { arbitraryFor } from "./arbitrary";
import { shapeOfType } from "./from-type";

/** An exported function the oracle can fuzz: its module, export name, and one
 *  fast-check arbitrary per parameter. */
export interface IPropTarget {
  readonly file: string; // absolute source path
  readonly exportName: string;
  readonly arbs: readonly string[];
}

/** True for a project source file we should consider. The program's files come
 *  from the tsconfig, so excluding declaration files + deps + our own cache dir
 *  leaves exactly the app's hand-written sources (no fragile cwd/root check —
 *  `program.getCurrentDirectory()` is process.cwd(), not the project root). */
function isAppSource(file: ts.SourceFile): boolean {
  return (
    !file.isDeclarationFile &&
    !file.fileName.includes("/node_modules/") &&
    !file.fileName.includes("/.tsforge/")
  );
}

/** A single export → target, or null when it isn't a fuzzable function (no or
 *  multiple call signatures, a rest param, or an unmodelable parameter type). */
function targetForExport(
  exp: ts.Symbol,
  source: ts.SourceFile,
  checker: ts.TypeChecker
): IPropTarget | null {
  const type = checker.getTypeOfSymbolAtLocation(exp, source);
  const sigs = type.getCallSignatures();

  if (sigs.length !== 1) {
    return null;
  }

  const params = sigs[0]?.getParameters() ?? [];

  if (params.length === 0) {
    return null; // nothing to fuzz
  }

  const arbs: string[] = [];

  for (const param of params) {
    const decl = param.valueDeclaration;

    if (decl !== undefined && ts.isParameter(decl) && decl.dotDotDotToken) {
      return null; // rest param — a single array arbitrary wouldn't spread right
    }

    const shape = shapeOfType(checker.getTypeOfSymbol(param), checker);

    if (shape === null) {
      return null;
    }

    arbs.push(arbitraryFor(shape));
  }

  return { file: source.fileName, exportName: exp.name, arbs };
}

/** Every fuzzable exported function in the program's own source. */
export function propertyTargets(
  program: ts.Program,
  checker: ts.TypeChecker
): IPropTarget[] {
  const targets: IPropTarget[] = [];

  for (const source of program.getSourceFiles()) {
    if (!isAppSource(source)) {
      continue;
    }

    const moduleSymbol = checker.getSymbolAtLocation(source);

    if (moduleSymbol === undefined) {
      continue;
    }

    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const target = targetForExport(exp, source, checker);

      if (target !== null) {
        targets.push(target);
      }
    }
  }

  return targets;
}

/** Import specifier (no extension) from the test file to a source file. */
function importPath(testFileAbs: string, sourceAbs: string): string {
  const rel = relative(dirname(testFileAbs), sourceAbs)
    .replace(/\.(ts|tsx)$/u, "")
    .split("\\")
    .join("/");

  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Render a runnable fast-check test file (pure): for each target, fuzz its
 * parameters and assert the call does not throw on valid typed input. Aliased
 * imports avoid name collisions across modules.
 */
export function renderPropertyFile(
  targets: readonly IPropTarget[],
  testFileAbs: string,
  fcImport = "fast-check"
): string {
  const imports = targets.map(
    (t, i) =>
      `import { ${t.exportName} as fn${i} } from "${importPath(testFileAbs, t.file)}";`
  );

  const blocks = targets.map((t, i) => {
    const args = t.arbs.map((_, a) => `a${a}`).join(", ");

    return [
      `test("property: ${t.exportName} does not throw on valid input", () => {`,
      `  fc.assert(`,
      `    fc.property(${t.arbs.join(", ")}, (${args}) => {`,
      `      fn${i}(${args});`,
      `      return true;`,
      `    }),`,
      `    { numRuns: 100 }`,
      `  );`,
      `});`,
    ].join("\n");
  });

  return [
    'import { test } from "bun:test";',
    `import fc from "${fcImport}";`,
    ...imports,
    "",
    ...blocks,
    "",
  ].join("\n");
}

/** Where the generated suite is written (under the git-ignored cache dir). */
export function propTestPath(cwd: string): string {
  return join(cwd, ".tsforge", "proptests", "generated.test.ts");
}
