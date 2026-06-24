import ts from "typescript";
import { isRecord, isArray } from "../lib/guards";

/** TS/JS source files a single-file parse is meaningful for. */
const TS_LIKE = /\.(?:m|c)?[tj]sx?$/u;

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }

  if (file.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }

  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }

  return ts.ScriptKind.TS;
}

/**
 * Count of pure SYNTAX/parse errors (TS1xxx — `';' expected`, `Declaration or
 * statement expected`, …) in `text` parsed as `file`. A single-file parse with NO
 * type program, so it's cheap (sub-millisecond) and sees only what `tsc` would
 * report before any semantic analysis — exactly the class of breakage a
 * mis-addressed line edit introduces. Non-TS/JS files (.md, .json, …) → 0.
 */
export function syntaxErrorCount(file: string, text: string): number {
  if (!TS_LIKE.test(file)) {
    return 0;
  }

  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    scriptKind(file)
  );

  // `parseDiagnostics` carries the syntactic errors. It isn't on the public
  // SourceFile type, but it's stable and what TS-based tooling reads for a
  // program-free syntax check. Narrow off `unknown` (no cast) — we only need its
  // length, so an array of unknown is enough.
  const node: unknown = sf;
  const diagnostics =
    isRecord(node) && isArray(node.parseDiagnostics)
      ? node.parseDiagnostics
      : undefined;

  return diagnostics?.length ?? 0;
}
