import { join, isAbsolute } from "node:path";
import ts from "typescript";
import type {
  ITsDiagnostic,
  ITsFix,
  ITsLocation,
  ITsSymbol,
} from "./lsp.types";

/**
 * Quick-fixes safe to apply automatically — they align with our strict gate.
 * Deliberately EXCLUDES `addNonNullAssertion` and anything inserting `as`/`!`,
 * which the constitution bans. The gate re-validates regardless, so a bad fix
 * can't ship, but we don't want the harness fighting its own rules.
 */
const SAFE_FIXES = new Set([
  "import",
  "fixMissingImport",
  "unusedIdentifier",
  "addMissingAwait",
  "fixOverrideModifier",
  "fixMissingMember",
  "fixMissingProperties",
  "fixUnreachableCode",
  "fixAddMissingConstraint",
]);

/**
 * Thin wrapper over the TypeScript LanguageService — the engine behind tsserver,
 * run in-process. Gives semantic diagnostics, TypeScript's own quick-fixes,
 * semantic rename, and type-at-cursor, scoped to one project's `tsconfig`. The
 * `tsc -p` gate stays the authority; this is for fixes / speed / semantics.
 */
export class TsService {
  private readonly service: ts.LanguageService;
  private readonly versions = new Map<string, number>();
  private readonly files: string[];

  constructor(private readonly dir: string) {
    const configPath = join(dir, "tsconfig.json");
    const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
    const parsed = ts.parseJsonConfigFileContent(
      read.config ?? {},
      ts.sys,
      dir
    );

    this.files = [...parsed.fileNames];

    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => this.files,
      getScriptVersion: (f) => String(this.versions.get(f) ?? 0),
      getScriptSnapshot: (f) => {
        const text = ts.sys.readFile(f);

        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => dir,
      getCompilationSettings: () => parsed.options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (p) => ts.sys.fileExists(p),
      readFile: (p) => ts.sys.readFile(p),
      readDirectory: (p, ext, exclude, include, depth) =>
        ts.sys.readDirectory(p, ext, exclude, include, depth),
      directoryExists: (p) => ts.sys.directoryExists(p),
      getDirectories: (p) => ts.sys.getDirectories(p),
    };

    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /** Re-read a file the harness changed on disk (bump its version, track new files). */
  refresh(file: string): void {
    const abs = this.toAbs(file);

    this.versions.set(abs, (this.versions.get(abs) ?? 0) + 1);

    if (!this.files.includes(abs)) {
      this.files.push(abs);
    }
  }

  diagnostics(file: string): ITsDiagnostic[] {
    const abs = this.toAbs(file);
    const raw = [
      ...this.service.getSyntacticDiagnostics(abs),
      ...this.service.getSemanticDiagnostics(abs),
    ];

    const out: ITsDiagnostic[] = [];

    for (const d of raw) {
      if (d.start === undefined || d.length === undefined) {
        continue;
      }

      out.push({
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        file: abs,
        start: d.start,
        length: d.length,
      });
    }

    return out;
  }

  quickFixes(file: string): ITsFix[] {
    const abs = this.toAbs(file);
    const prefs: ts.UserPreferences = {};
    const fmt = ts.getDefaultFormatCodeSettings("\n");
    const fixes: ITsFix[] = [];

    for (const d of this.diagnostics(file)) {
      const actions = this.service.getCodeFixesAtPosition(
        abs,
        d.start,
        d.start + d.length,
        [d.code],
        fmt,
        prefs
      );

      for (const a of actions) {
        fixes.push({ description: a.description, changes: a.changes });
      }
    }

    return fixes;
  }

  /**
   * Apply TypeScript's own safe quick-fixes to `file` until none remain — the
   * deterministic "eslint --fix, but for TS" step. Returns how many were applied.
   * Iterative (apply one, re-ground) so cascading fixes resolve cleanly.
   */
  fixAll(file: string, maxPasses = 20): number {
    let applied = 0;

    for (let pass = 0; pass < maxPasses; pass += 1) {
      const fix = this.firstSafeFix(file);

      if (fix === undefined) {
        break;
      }

      this.applyChanges(fix.changes);
      applied += 1;
    }

    return applied;
  }

  private firstSafeFix(file: string): ts.CodeFixAction | undefined {
    const abs = this.toAbs(file);
    const fmt = ts.getDefaultFormatCodeSettings("\n");

    for (const d of this.diagnostics(file)) {
      const actions = this.service.getCodeFixesAtPosition(
        abs,
        d.start,
        d.start + d.length,
        [d.code],
        fmt,
        {}
      );

      for (const a of actions) {
        if (SAFE_FIXES.has(a.fixName)) {
          return a;
        }
      }
    }

    return undefined;
  }

  private applyChanges(changes: readonly ts.FileTextChanges[]): void {
    for (const fc of changes) {
      const original = ts.sys.readFile(fc.fileName);

      if (original === undefined) {
        continue;
      }

      // Apply edits back-to-front so earlier spans keep their offsets.
      const sorted = [...fc.textChanges].sort(
        (a, b) => b.span.start - a.span.start
      );
      let text = original;

      for (const tc of sorted) {
        text =
          text.slice(0, tc.span.start) +
          tc.newText +
          text.slice(tc.span.start + tc.span.length);
      }

      ts.sys.writeFile(fc.fileName, text);
      this.refresh(fc.fileName);
    }
  }

  /** Find every reference to rename (Slice 3 adds the new name + applies them). */
  renameLocations(
    file: string,
    position: number
  ): readonly ts.RenameLocation[] | undefined {
    return this.service.findRenameLocations(
      this.toAbs(file),
      position,
      false,
      false,
      {}
    );
  }

  typeAt(file: string, position: number): string {
    const info = this.service.getQuickInfoAtPosition(
      this.toAbs(file),
      position
    );

    if (info === undefined) {
      return "";
    }

    return ts.displayPartsToString(info.displayParts);
  }

  /** All references to the symbol at `position` (across the project). */
  references(file: string, position: number): ITsLocation[] {
    const refs = this.service.getReferencesAtPosition(
      this.toAbs(file),
      position
    );

    return (refs ?? []).map((r) => ({
      file: r.fileName,
      line: this.lineOf(r.fileName, r.textSpan.start),
      start: r.textSpan.start,
    }));
  }

  /** Definition location(s) of the symbol at `position`. */
  definition(file: string, position: number): ITsLocation[] {
    const defs = this.service.getDefinitionAtPosition(
      this.toAbs(file),
      position
    );

    return (defs ?? []).map((d) => ({
      file: d.fileName,
      line: this.lineOf(d.fileName, d.textSpan.start),
      start: d.textSpan.start,
    }));
  }

  /** Workspace symbol search by name (navigate-to) — find a symbol/file without
   *  knowing the path. */
  symbols(query: string, max = 50): ITsSymbol[] {
    return this.service.getNavigateToItems(query, max).map((i) => ({
      name: i.name,
      kind: i.kind,
      file: i.fileName,
      line: this.lineOf(i.fileName, i.textSpan.start),
    }));
  }

  /**
   * Semantic rename across ALL references, applied to disk. Returns the number
   * of locations changed, or null if the symbol can't be renamed. Callers must
   * enforce scope (a rename can touch read-only files — the loop checks).
   */
  rename(file: string, position: number, newName: string): number | null {
    const locs = this.service.findRenameLocations(
      this.toAbs(file),
      position,
      false,
      false,
      {}
    );

    if (locs === undefined || locs.length === 0) {
      return null;
    }

    const byFile = new Map<string, ts.TextChange[]>();

    for (const loc of locs) {
      const arr = byFile.get(loc.fileName) ?? [];

      arr.push({ span: loc.textSpan, newText: newName });
      byFile.set(loc.fileName, arr);
    }

    const changes: ts.FileTextChanges[] = [...byFile].map(
      ([fileName, textChanges]) => ({ fileName, textChanges, isNewFile: false })
    );

    this.applyChanges(changes);

    return locs.length;
  }

  /** Which files a rename at `position` would touch (for scope-checking BEFORE
   *  applying). Absolute paths. */
  renameTargets(file: string, position: number): string[] {
    const locs = this.service.findRenameLocations(
      this.toAbs(file),
      position,
      false,
      false,
      {}
    );

    return [...new Set((locs ?? []).map((l) => l.fileName))];
  }

  /** Organize imports (dedupe/sort/drop unused) for one file. Returns edits made. */
  organizeImports(file: string): number {
    const changes = this.service.organizeImports(
      { type: "file", fileName: this.toAbs(file) },
      ts.getDefaultFormatCodeSettings("\n"),
      {}
    );

    if (changes.length === 0) {
      return 0;
    }

    this.applyChanges(changes);

    return changes.reduce((n, c) => n + c.textChanges.length, 0);
  }

  /**
   * Ergonomic position lookup: the model addresses symbols by NAME, not byte
   * offset. Returns the offset of the first word-boundary occurrence of `symbol`
   * in `file`, or undefined. Crude but practical (rename re-validates via the
   * gate; references/typeAt are read-only).
   */
  positionOfSymbol(file: string, symbol: string): number | undefined {
    const text = ts.sys.readFile(this.toAbs(file));

    if (text === undefined) {
      return undefined;
    }

    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\b${escaped}\\b`).exec(text);

    return match === null ? undefined : match.index;
  }

  /** 1-based line number of a byte offset in a file (for readable tool output). */
  private lineOf(file: string, position: number): number {
    const text = ts.sys.readFile(file) ?? "";

    return text.slice(0, position).split("\n").length;
  }

  private toAbs(file: string): string {
    return isAbsolute(file) ? file : join(this.dir, file);
  }
}
