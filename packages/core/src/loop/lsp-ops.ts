import { relative } from "node:path";
import { runCommand, fileArg, TOOL_NAME, type ToolName } from "../agent";
import { writable } from "../lib/scope";
import { LIMITS } from "../constants";
import { str, reject, type IToolContext } from "./tool-context";

/** ripgrep search over the working dir — the model's primary navigation at
 *  scale (structural/text, fast). Falls back gracefully if `rg` is absent. */
export async function doSearch(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const fromPattern = str(args, "pattern");
  const pattern = fromPattern.length > 0 ? fromPattern : str(args, "query");

  if (pattern.length === 0) {
    return "search: malformed args (need `pattern`)";
  }

  const glob = str(args, "glob");
  const globArg = glob.length > 0 ? ` -g ${JSON.stringify(glob)}` : "";
  const cmd = `rg --line-number --no-heading --color never -e ${JSON.stringify(pattern)}${globArg} || true`;
  const res = await runCommand(ctx.cwd, cmd);
  const out = `${res.stdout}${res.stderr}`.slice(0, LIMITS.maxToolOutputChars);

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `search ${pattern}${glob.length > 0 ? ` (${glob})` : ""}`,
  });

  return out.trim().length > 0 ? out : `no matches for ${pattern}`;
}

/** Dispatch the semantic (LanguageService-backed) tools. The model addresses
 *  symbols by NAME + file; read-only tools are unrestricted, the two that WRITE
 *  (rename_symbol, organize_imports) are scope-enforced. */
export function doLsp(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: IToolContext
): string {
  const svc = ctx.tsService;

  if (svc === undefined || svc === null) {
    return `${name}: unavailable (this project has no TypeScript LanguageService)`;
  }

  const file = fileArg(args) ?? "";
  const rel = (abs: string): string => relative(ctx.cwd, abs);

  if (name === TOOL_NAME.symbolSearch) {
    const q = str(args, "query");
    const query = q.length > 0 ? q : str(args, "symbol");

    if (query.length === 0) {
      return "symbol_search: need `query`";
    }

    const hits = svc.symbols(query);

    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `symbol_search ${query} → ${hits.length}`,
    });

    return hits.length === 0
      ? `no symbols matching '${query}'`
      : hits
          .map((h) => `${h.kind} ${h.name} — ${rel(h.file)}:${h.line}`)
          .join("\n");
  }

  if (name === TOOL_NAME.diagnostics) {
    if (file.length === 0) {
      return "diagnostics: need `file`";
    }

    const diags = svc.diagnostics(file);

    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `diagnostics ${file} → ${diags.length}`,
    });

    return diags.length === 0
      ? `no semantic diagnostics in ${file}`
      : diags
          .map((d) => `TS${d.code}: ${d.message.split("\n")[0] ?? d.message}`)
          .join("\n");
  }

  // The remaining tools address a symbol by name within a file.
  return doSymbolLsp(name, svc, file, args, ctx, rel);
}

type LspService = NonNullable<IToolContext["tsService"]>;

/** The LSP tools that resolve a symbol position first (type_at, find_references,
 *  organize_imports, rename_symbol). Split out of doLsp to keep each function's
 *  branching small. */
function doSymbolLsp(
  name: ToolName,
  svc: LspService,
  file: string,
  args: Record<string, unknown>,
  ctx: IToolContext,
  rel: (abs: string) => string
): string {
  const symbol = str(args, "symbol");

  if (file.length === 0 || symbol.length === 0) {
    return `${name}: need {file, symbol}`;
  }

  const pos = svc.positionOfSymbol(file, symbol);

  if (pos === undefined) {
    return `${name}: '${symbol}' not found in ${file}`;
  }

  if (name === TOOL_NAME.typeAt) {
    const type = svc.typeAt(file, pos);

    ctx.report({ kind: "tool", task: ctx.task, message: `type_at ${symbol}` });

    return type.length > 0
      ? `${symbol}: ${type}`
      : `no type info for ${symbol}`;
  }

  if (name === TOOL_NAME.findReferences) {
    const refs = svc.references(file, pos);

    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `find_references ${symbol} → ${refs.length}`,
    });

    return refs.length === 0
      ? `no references to '${symbol}'`
      : refs.map((r) => `${rel(r.file)}:${r.line}`).join("\n");
  }

  if (name === TOOL_NAME.organizeImports) {
    if (!writable(file, ctx.files)) {
      return reject(
        ctx,
        "organize_imports",
        `organize_imports ${file} REJECTED: out of scope.`
      );
    }

    const n = svc.organizeImports(file);

    ctx.report({
      kind: "tool",
      task: ctx.task,
      message: `organize_imports ${file} (${n})`,
    });

    return `organize_imports: ${n} change(s) in ${file}`;
  }

  // rename_symbol — scope-enforced: a semantic rename can touch many files; it
  // must NOT edit read-only/out-of-scope ones.
  const newName = str(args, "newName");

  if (newName.length === 0) {
    return "rename_symbol: need `newName`";
  }

  const targets = svc.renameTargets(file, pos).map(rel);
  const outOfScope = targets.filter((t) => !writable(t, ctx.files));

  if (outOfScope.length > 0) {
    return reject(
      ctx,
      "rename_symbol",
      `rename '${symbol}' REJECTED: would edit out-of-scope/read-only file(s): ${outOfScope.join(", ")}. Rename only symbols whose every reference is in your editable files.`
    );
  }

  const changed = svc.rename(file, pos, newName);

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `rename_symbol ${symbol}→${newName} (${changed ?? 0})`,
  });

  return changed === null
    ? `rename_symbol: '${symbol}' can't be renamed here`
    : `renamed '${symbol}' → '${newName}' across ${changed} location(s)`;
}
