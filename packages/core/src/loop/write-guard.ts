import { readFileSync } from "node:fs";
import { basename, join, relative, isAbsolute } from "node:path";
import { flags } from "../config";
import type { TsService, ITsDiagnostic } from "../lsp";
import type { FileLinter, IFileLintProblem } from "../detect-gate";
import { formatFile } from "../detect-gate";
import { stripLiteralCasts } from "./astgrep-fix";
import {
  runMetaRules,
  PER_WRITE_META_RULES,
  type IMetaRuleContext,
} from "../meta-rules";
import type { Reporter } from "./loop.types";
import type { ILoopCtx } from "./turn";

/**
 * The WRITE-TIME GUARD: the moment the model writes a file, check JUST that file
 * (type + lint + structural meta-rules + cross-file blast radius) and hand any real
 * problems back as the tool result, so the model fixes them THIS turn instead of
 * discovering a cascade at the end-of-turn gate. Best-effort: a guard failure never
 * breaks the build — the gate stays the authority. Extracted from turn.ts so the
 * turn loop stays focused; `runWriteGuard` is the single entry point.
 */

/** Diagnostic codes that are EXPECTED noise mid-build, not real mistakes: 2307 =
 *  "cannot find module" (a sibling the model hasn't created yet in this batch). */
const TRANSIENT_DIAG_CODES = new Set<number>([2307]);

/**
 * The write-guard and interim check run `tsc` WITHOUT a build, so they see the STUB
 * `routeTree.gen.ts` (only `/` + `__root__` registered). TanStack Router's types are
 * driven by that tree, so EVERY route-API type usage is a phantom error there — and
 * route correctness can ONLY be validated against the real tree, which the gate's
 * build-first step regenerates. So we ignore ALL route-API type errors at write/
 * interim time; the GATE still validates routes for real.
 *
 * Measured across overnight CRM builds, these phantoms took MANY message shapes
 * (≈51 of ~67 errors in build #2 alone): `to` unions in any order (`"/" | "." | ".."`,
 * `"." | ".." | "/"`), bare `"/"` params, `createFileRoute` constraints, and
 * `params={{…}}` excess-property errors. Path/shape matching was whack-a-mole, so we
 * match the ROUTER'S INTERNAL TYPE SIGNATURES instead — robust to ordering and form.
 * SAFE: a genuinely wrong route still fails the gate (real tree); we only suppress
 * the un-fixable write/interim noise the model would otherwise chase.
 */
const ROUTE_API_SIGNATURES: readonly RegExp[] = [
  /ConstrainLiteral</, //                       `<Link to>` / createFileRoute path constraint
  /ParamsReducerFn</, //                         `params={{…}}` on a typed route
  /"__root__"/, //                               stub route-id union (`"__root__" | "/"`)
  /keyof FileRoutesByPath/, //                  navigate({ to }) target union
  // A target type union composed ONLY of the nav literals "/", ".", ".." (any
  // order/subset) — the EARLY stub tree, before any real route exists.
  /assignable to (?:parameter of )?type '(?:"\/"|"\."|"\.\.")(?:\s*\|\s*(?:"\/"|"\."|"\.\."))*'/,
  // The same `<Link to>` / navigate target-union error AFTER real routes exist: the
  // union ALWAYS still contains the ".." nav literal — which a normal string-literal
  // union never does — so an "assignable to … type '…\"..\"…'" error is a route
  // phantom REGARDLESS of which real routes are also in the union. (The nav-only
  // pattern above STOPPED matching once the union grew, so the model got nagged to
  // "fix" forward-referenced links (e.g. to="/x/create" written before x.create.tsx
  // lands + routeTree regenerates) that the build resolves on its own — ~1/3 of a
  // multi-route build burned chasing them. The real gate rebuilds the tree and still
  // catches a genuinely missing route.)
  /assignable to (?:parameter of )?type '[^']*"\.\."[^']*'/,
  // `Route.useParams()` against the stub gives EMPTY params (`{}` or `never`), so a
  // `route.params.<name>` access fails. ≥2 builds (night2 `never` ×84, twitter `{}` ×6).
  // Broadest signal here — a real `{}`/`never` property access would also match — but
  // those are rare and the GATE (real tree) still catches any genuine one.
  /Property '[^']+' does not exist on type '(?:\{\}|never)'/,
];

/** A TanStack route-API type error seen at write/interim time against the stub tree —
 *  a phantom the build erases; never surface it (the gate validates routes for real). */
export function isPhantomRouteError(message: string): boolean {
  return ROUTE_API_SIGNATURES.some((re) => re.test(message));
}

/** A diagnostic that's expected mid-build noise (missing sibling module, or the
 *  stub-route-tree phantom) — not a real mistake the model should chase. */
function isTransientDiag(d: { code: number; message: string }): boolean {
  return TRANSIENT_DIAG_CODES.has(d.code) || isPhantomRouteError(d.message);
}

/** Max diagnostics surfaced per write — keep the in-band feedback tight. */
const MAX_WRITE_GUARD_DIAGS = 5;

/** Render the per-issue lines (type errors + lint problems), capped + ordered. */
function writeGuardLines(
  absPath: string,
  typeErrors: readonly ITsDiagnostic[],
  lintProblems: readonly IFileLintProblem[]
): string {
  let text = "";

  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    text = "";
  }

  const lineOf = (offset: number): number =>
    text.slice(0, offset).split("\n").length;
  // Slice to the cap BEFORE mapping: lineOf does O(offset) string work per diag,
  // so mapping every error in a large file (then discarding all but 5) is wasteful.
  // Output is identical to map-all-then-slice (type errors fill the budget first).
  const total = typeErrors.length + lintProblems.length;
  const typeLines = typeErrors
    .slice(0, MAX_WRITE_GUARD_DIAGS)
    .map(
      (d) => `  L${String(lineOf(d.start))}: ${d.message} (TS${String(d.code)})`
    );
  const lintLines = lintProblems
    .slice(0, MAX_WRITE_GUARD_DIAGS - typeLines.length)
    .map((p) => `  L${String(p.line)}: ${p.message} (${p.ruleId})`);
  const shown = [...typeLines, ...lintLines].join("\n");
  const more =
    total > MAX_WRITE_GUARD_DIAGS
      ? `\n  …and ${String(total - MAX_WRITE_GUARD_DIAGS)} more`
      : "";

  return `${shown}${more}`;
}

/** Max dependant files (and errors each) to name in the blast-radius section. */
const MAX_DEP_FILES = 4;
const MAX_DEP_ERRORS = 2;

/**
 * Render the CROSS-FILE blast radius: the dependant files an edit broke, with the
 * first error(s) in each. Empty string when nothing downstream broke. This is the
 * write-guard reaching across the import graph (see TsService.dependantErrors).
 */
function dependantBlastRadius(
  dependants: readonly { file: string; errors: readonly ITsDiagnostic[] }[]
): string {
  if (dependants.length === 0) {
    return "";
  }

  const blocks = dependants.slice(0, MAX_DEP_FILES).map((d) => {
    let text = "";

    try {
      text = readFileSync(d.file, "utf8");
    } catch {
      text = "";
    }

    const lineOf = (offset: number): number =>
      text.slice(0, offset).split("\n").length;

    return d.errors
      .slice(0, MAX_DEP_ERRORS)
      .map(
        (e) =>
          `  ${basename(d.file)}:${String(lineOf(e.start))} ${e.message} (TS${String(e.code)})`
      )
      .join("\n");
  });
  const more =
    dependants.length > MAX_DEP_FILES
      ? `\n  …and ${String(dependants.length - MAX_DEP_FILES)} more file(s)`
      : "";

  return (
    `\n\n⚠ BLAST RADIUS — this change broke ${String(dependants.length)} file(s) that ` +
    `depend on it. Fix them too, or revert the change (e.g. a signature you altered):\n` +
    `${blocks.join("\n")}${more}`
  );
}

/**
 * WRITE-TIME GUARD: the moment the model writes a file, check JUST that file and
 * hand any real problems back AS THE TOOL RESULT — so the model fixes them THIS
 * turn, while the file is fresh, before building more on a broken foundation. Two
 * layers: (1) tsc diagnostics via the in-process language service (real type
 * errors); (2) the gate's eslint rules on this one file (when `lintFile` is wired)
 * — the STRICTNESS MOAT (`no-as`, `I`-prefix, `prefer-template`) that tsc is blind
 * to. A run log showed `Object.keys(x) as unknown as …` written in every domain
 * file: type-valid, so the old type-only guard passed it, and the `as` violations
 * piled up unseen until the gate. Together they convert the dominant failure mode
 * (write 8 files → discover a 40-issue cascade at the gate → many repair turns)
 * into (write 1 file → see its issue now → fix it). Transient "cannot find module"
 * for not-yet-created siblings is filtered as expected noise.
 */
async function writeGuard(
  ctx: { tsService: TsService; cwd: string; lintFile?: FileLinter },
  file: string,
  report: Reporter,
  taskId: string
): Promise<string> {
  const { tsService, cwd, lintFile } = ctx;
  // `file` is workspace-relative (the create/edit handler normalized it); the
  // strip/linter/readFileSync need the absolute path.
  const absPath = join(cwd, file);
  // Strip the model's reflexive needless literal-to-union casts NOW (deterministic,
  // safe) so it's never told about them and never spends a turn removing them.
  const stripped = await stripLiteralCasts(absPath).catch(() => 0);

  if (stripped > 0) {
    report({
      kind: "tool",
      task: taskId,
      message: `stripped ${String(stripped)} needless literal cast(s) in ${basename(absPath)}`,
    });
  }

  // Auto-format this file NOW (eslint --fix + prettier) — not at the settle
  // gate. Otherwise the mechanical lint (blank lines, braces, quotes) sits
  // unfixed between writes, and when the model self-runs the gate it sees the
  // noise and hand-chases it to the turn cap. Best-effort; gate stays authority.
  await formatFile(cwd, file);

  tsService.refresh(file);

  const typeErrors = tsService
    .diagnostics(file)
    .filter((d) => !isTransientDiag(d));
  const lintProblems = lintFile === undefined ? [] : await lintFile(absPath);
  // BLAST RADIUS: files that depend on this one and now have errors. Computed even
  // when THIS file is clean — a signature change can compile here but break callers.
  // Drop the stub-route phantom here too (the build regenerates the tree).
  const dependants = tsService
    .dependantErrors(file, TRANSIENT_DIAG_CODES)
    .map((d) => ({
      file: d.file,
      errors: d.errors.filter((e) => !isPhantomRouteError(e.message)),
    }))
    .filter((d) => d.errors.length > 0);
  const total = typeErrors.length + lintProblems.length;

  if (total === 0 && dependants.length === 0) {
    return "";
  }

  const detail = writeGuardLines(absPath, typeErrors, lintProblems);
  const blast = dependantBlastRadius(dependants);
  const depNote =
    dependants.length > 0
      ? `, ${String(dependants.length)} dependant file(s) broken`
      : "";

  // Surface the ACTUAL errors (codes + messages) into the event — not just a count —
  // so the log shows WHAT failed (the corrective feedback also rides the tool result).
  // A log without the real errors can't tell us which mistakes are systematic.
  report({
    kind: "tool",
    task: taskId,
    message: `⚠ write-check: ${String(typeErrors.length)} type + ${String(lintProblems.length)} lint issue(s)${depNote} in ${basename(absPath)}:\n${detail}${blast}`,
  });

  if (total === 0) {
    return blast;
  }

  return (
    `\n\n⚠ CHECK of this file found ${String(total)} issue(s) — fix them now ` +
    "(edit this file) before writing others; ignore any 'cannot find module' for " +
    `files you'll create next:\n${detail}${blast}`
  );
}

/** A meta-rule context scoped to ONE just-written file, so the per-write rules
 *  check exactly that file. The file is placed in whichever list field matches its
 *  kind (mirroring buildMetaRuleContext's categorization); the other lists are
 *  empty, so a rule for a different category is a no-op. Cheap: no directory walk. */
function singleFileMetaContext(
  cwd: string,
  path: string,
  packs: readonly string[]
): IMetaRuleContext {
  const rel = (isAbsolute(path) ? relative(cwd, path) : path).replaceAll(
    "\\",
    "/"
  );
  const base = basename(rel);
  const isSource = /\.tsx?$/u.test(rel) && !rel.endsWith(".gen.ts");
  const isWorkflow = /^\.github\/workflows\/.+\.ya?ml$/u.test(rel);
  const isDockerfile =
    base === "Dockerfile" ||
    base.startsWith("Dockerfile.") ||
    base.endsWith(".Dockerfile");
  const one = [rel];

  const readFile = (p: string): string | null => {
    try {
      return readFileSync(join(cwd, p), "utf8");
    } catch {
      return null;
    }
  };

  return {
    root: cwd,
    packageJson: null,
    sourceFiles: isSource ? one : [],
    changedFiles: one,
    configFiles: [],
    workflowFiles: isWorkflow ? one : [],
    dockerfiles: isDockerfile ? one : [],
    activePacks: packs,
    readFile,
  };
}

/** Run the single-file-safe meta-rules on the just-written file and format any
 *  violations as an early advisory — the structural counterpart to the type/lint
 *  write-guard, so "missing test", "eslint-disable", etc. surface NOW (one file)
 *  instead of at the end-of-turn gate. The gate stays the hard wall. Best-effort. */
function perWriteMetaFeedback(ctx: ILoopCtx, path: string): string {
  try {
    const metaCtx = singleFileMetaContext(
      ctx.cwd,
      path,
      ctx.stackProfile?.packs ?? []
    );
    const violations = runMetaRules(
      PER_WRITE_META_RULES,
      metaCtx,
      ctx.ruleOverrides
    );

    if (violations.length === 0) {
      return "";
    }

    const lines = violations
      .slice(0, MAX_WRITE_GUARD_DIAGS)
      .map((v) => `  • [${v.ruleId}] ${v.message}`)
      .join("\n");

    return `\n\n⚠ STRUCTURE check — fix now, while this is one file (the gate enforces these):\n${lines}`;
  } catch {
    return "";
  }
}

/**
 * Invoke the write-guard for a just-written file — best-effort: a guard failure
 * must NEVER break the build (the gate stays the authority), so a null service or
 * any thrown error degrades to no feedback. Extracted so `runToolCalls` stays
 * under the cognitive-complexity bar. Two layers: the type/lint guard (needs the
 * LanguageService) and the per-write structural meta-rules (no service needed, so
 * they run even without a tsconfig — e.g. a missing-test nudge).
 */
export async function runWriteGuard(
  ctx: ILoopCtx,
  path: string
): Promise<string> {
  if (path.length === 0) {
    return "";
  }

  let guard = "";

  if (ctx.tsService !== null && flags.lspWriteFeedback()) {
    try {
      guard = await writeGuard(
        {
          tsService: ctx.tsService,
          cwd: ctx.cwd,
          ...(ctx.lintFile === undefined ? {} : { lintFile: ctx.lintFile }),
        },
        path,
        ctx.report,
        ctx.task.id
      );
    } catch {
      guard = "";
    }
  }

  return `${guard}${perWriteMetaFeedback(ctx, path)}`;
}
