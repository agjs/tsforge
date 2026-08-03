import { relative } from "node:path";
import { fileArg, TOOL_NAME, type ToolName } from "../../agent";
import { runArgvCommand } from "../../lib/fs";
import { writable } from "../../lib/scope";
import { LOOP_LIMITS } from "../loop.constants";
import {
  str,
  reject,
  resolveWritable,
  type IToolContext,
} from "./tool-context";

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
  // Spawn rg with an explicit argv (NO shell) — the pattern/glob come from the
  // model, so a `sh -c` string would let `$()`/backticks inside them execute.
  const argv = [
    "rg",
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "-e",
    pattern,
    ...(glob.length > 0 ? ["-g", glob] : []),
  ];
  const res = await runArgvCommand(
    ctx.cwd,
    argv,
    ctx.signal === undefined ? {} : { signal: ctx.signal }
  );
  // rg exits 1 when there are simply no matches (not an error); 2 = real error,
  // 127 = rg absent. Surface stderr only on a real failure, not on "no matches".
  const body = res.exitCode > 1 ? `${res.stdout}${res.stderr}` : res.stdout;
  const out = body.slice(0, LOOP_LIMITS.maxToolOutputChars);

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

  // organize_imports operates on a whole FILE (no symbol/position) — handle it
  // here, before doSymbolLsp's `need {file, symbol}` guard would wrongly reject a
  // valid `{file}`-only call (its schema requires only `file`). See P1 review.
  if (name === TOOL_NAME.organizeImports) {
    return doOrganizeImports(svc, file, ctx);
  }

  // move_file takes {from, to} (not {file, symbol}) — handle before doSymbolLsp's
  // symbol guard. Scope-enforced: a move rewrites importers across the project; it
  // must NOT touch read-only/out-of-scope/vendored files.
  if (name === TOOL_NAME.moveFile) {
    return doMoveFile(svc, args, ctx, rel);
  }

  // The remaining tools address a symbol by name within a file.
  return doSymbolLsp(name, svc, file, args, ctx, rel);
}

/** organize_imports: scope-enforced, single-file import cleanup. Emits `mutated`
 *  (re-gate + change-scope) only when imports actually changed. */
function doOrganizeImports(
  svc: LspService,
  file: string,
  ctx: IToolContext
): string {
  if (file.length === 0) {
    return "organize_imports: need `file`";
  }

  const target = resolveWritable(ctx, file);

  if (!target.writable) {
    return reject(
      ctx,
      "organize_imports",
      `organize_imports ${target.path} REJECTED: out of scope.`
    );
  }

  const n = svc.organizeImports(target.path);

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `organize_imports ${target.path} (${n})`,
    ...(n > 0 ? { mutated: [target.path] } : {}),
  });

  return `organize_imports: ${n} change(s) in ${target.path}`;
}

/** move_file: relocate a file and rewrite every importer's specifier. */
function doMoveFile(
  svc: LspService,
  args: Record<string, unknown>,
  ctx: IToolContext,
  rel: (abs: string) => string
): string {
  const from = str(args, "from");
  const to = str(args, "to");

  if (from.length === 0 || to.length === 0) {
    return "move_file: need {from, to}";
  }

  const targets = svc.moveTargets(from, to).map(rel);
  const blocked = targets.filter((t) => !writable(t, ctx.files));

  if (blocked.length > 0) {
    return reject(
      ctx,
      "move_file",
      `move '${from}' → '${to}' REJECTED: would touch out-of-scope/read-only file(s): ${blocked.join(", ")}. Move files only when the source, destination, and every importer are in your editable scope.`
    );
  }

  const changed = svc.moveFile(from, to);

  ctx.report({
    kind: "tool",
    task: ctx.task,
    message: `move_file ${from}→${to} (${changed ?? 0})`,
    // moveTargets includes the destination + every rewritten importer; re-gate
    // and change-scope them — only when the move actually happened.
    ...(changed === null ? {} : { mutated: targets }),
  });

  return changed === null
    ? `move_file: source '${from}' not found`
    : `moved '${from}' → '${to}', updated imports across ${changed} file(s)`;
}

type LspService = NonNullable<IToolContext["tsService"]>;

/** The LSP tools that resolve a symbol position first (type_at, find_references,
 *  rename_symbol). Split out of doLsp to keep each function's branching small. */
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
    // Re-gate + change-scope the rewritten files — only on a real rename.
    ...(changed === null ? {} : { mutated: targets }),
  });

  return changed === null
    ? `rename_symbol: '${symbol}' can't be renamed here`
    : `renamed '${symbol}' → '${newName}' across ${changed} location(s)`;
}
