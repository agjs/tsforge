import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import ts from "typescript";
import type { IGate, IStage } from "../../gate/gate-runner";
import { composeGate, differentialStage } from "../../gate/gate-runner";
import type { IValidateResult, IErrorItem } from "../../validate";
import type { IProvider } from "../../inference";
import type { IFeature } from "../greenfield/greenfield.types";
import type { Exec } from "./exec";
import { runBoringstackGate } from "./gate";
import { extractFailures, ESLINT_PROGRAM_UNPARSABLE } from "./extract-failures";
import { verifyFeatureReachable } from "./reachability";
import { judgeFeature } from "../greenfield/judge";
import {
  autofixApps,
  featureOwnedGlobs,
  readResourceCode,
  rescueFileFor,
} from "./build";
import type { IEntityAcceptance } from "../acceptance/acceptance.types";
import { checkTestIds } from "./acceptance/testid-contract";
import { FLAG_ON, ENV_FLAG } from "../../config/config.constants";

/** Turn one failure signature into an `IErrorItem`. Most signatures are their own
 *  message (the raw gate row). A `knip:unused-file:<path>` signature is enriched
 *  into an ACTIONABLE error naming the file + the fix — because the wall that
 *  ground a live run was a co-located API test knip rejected forever, and the model
 *  never got told the concrete way out (delete it / use the mirrored `tests/` path,
 *  the only knip entry for tests in this stack). */
function phaseForFile(file: string): number | undefined {
  if (file.startsWith("apps/api/")) {
    return 1;
  }

  if (file.startsWith("apps/ui/")) {
    return 2;
  }

  return file.length > 0 ? 3 : undefined;
}

export function signatureToError(sig: string): IErrorItem {
  const knip = /^knip:unused-file:(.+)$/u.exec(sig);

  if (knip !== null) {
    const file = knip[1] ?? "";

    return {
      key: sig,
      rule: "knip/unused-files",
      file,
      ...(phaseForFile(file) === undefined
        ? {}
        : { phase: phaseForFile(file) }),
      message:
        `knip: unused file ${file} — it isn't reachable from any configured entry, ` +
        `so it must go. If it's a co-located API test under src/**/*.test.ts, DELETE ` +
        `it and put the test at the mirrored tests/ path instead (this stack's knip ` +
        `entries for tests are tests/**/*.test.ts, NOT co-located src tests). For a ` +
        `production file, wire it from an entry (e.g. an index.ts barrel) or delete it.`,
    };
  }

  const openapi = /^openapi-unreachable:(.*)$/u.exec(sig);

  if (openapi !== null) {
    // NO file — this is an infra/precondition failure (the API isn't serving its
    // spec), not a diagnostic in an editable file. A file (even "") would get it
    // mis-classified as an out-of-scope/locked-file error; with no file it stays an
    // "own", model-visible error carrying the actionable infra message. Phase 2
    // (the apps/ui stage it comes from) so the frontier accounting matches the
    // opaque apps/ui fallback it replaces. The signature carries a STABLE failure
    // class (connection-refused / timeout / dns / http-NNN / unreachable); the full
    // guidance is built here so the key stays stable across reason wording.
    const failureClass = openapi[1] ?? "unreachable";

    return {
      key: sig,
      rule: "openapi-unreachable",
      phase: 2,
      message:
        `generate:api could not fetch the OpenAPI spec (${failureClass}). The API ` +
        `is not serving /swagger/json. This is an INFRA PRECONDITION, not something ` +
        `to fix in code — the BoringStack stack must be running (bring it up with ` +
        `dev.sh up). If the stack IS up, your apps/api changes may have broken the ` +
        `server so it can't boot — check apps/api compiles and starts. Do NOT edit ` +
        `UI code to chase this.`,
    };
  }

  if (sig === ESLINT_PROGRAM_UNPARSABLE) {
    // The whole type-aware ESLint program failed to build — collapsed from a
    // per-file `parserOptions.project` cascade (see extract-failures). File-less so
    // it stays a model-visible "own" error, not an out-of-scope one.
    return {
      key: sig,
      rule: "eslint-program-unparsable",
      phase: 2,
      message:
        "The TypeScript-aware lint could not build its program: one or more source files have a " +
        "real syntax/parse error (`Parsing error: … expected`), which makes ESLint report a " +
        "`parserOptions.project` parse error on many files at once — do NOT chase the per-file " +
        "cascade. Find the genuine syntax error(s) in the files YOU OWN (your feature's own dirs) " +
        "and fix each cleanly; a `.ts` file that contains JSX must be renamed to `.tsx` (a `.ts` " +
        "parses `<X>` as a generic and demands `>`). Do NOT wholesale-rewrite shared files. Every " +
        "broken file must parse before the cascade clears.",
    };
  }

  const structured = /^failure:([^:]*):([^:]*):([^:]*):(.*)$/u.exec(sig);

  if (structured !== null) {
    const file = decodeURIComponent(structured[1] ?? "");
    const lineText = structured[2] ?? "";
    const rule = decodeURIComponent(structured[3] ?? "");
    const message = decodeURIComponent(structured[4] ?? "");
    const phase = phaseForFile(file);

    return {
      key: sig,
      file,
      ...(lineText === "" ? {} : { line: Number(lineText) }),
      rule,
      ...(phase === undefined ? {} : { phase }),
      message: structuredSteerMessage(message, file),
    };
  }

  return { key: sig, message: sig };
}

/** Enrich a structured gate error's raw message with the actionable steer for the failure
 *  classes the model chronically mis-fixes (each observed live). Extracted from
 *  signatureToError to keep that function's branching under the cognitive-complexity cap. */
function structuredSteerMessage(message: string, file: string): string {
  // A syntax/parse error (`'>' expected`, `Parsing error`, `Unexpected token`) is the one class
  // the model can't fix by surgical patch — a patch on an already-broken file usually re-breaks
  // its braces/generics/JSX, so it grinds at the SAME error for turns (observed live: stuck at 2
  // `'>' expected` for 40min). Steer it to REWRITE THE WHOLE FILE, and flag the JSX-in-`.ts` case.
  const isParse = /parsing error|unexpected token|expected\.?\s*$/iu.test(
    message
  );

  if (isParse) {
    // The `.tsx` tip is ONLY valid for the JSX/generic `'>' expected` class.
    const isJsxGenericParse = /['`]>['`]\s+expected/iu.test(message);
    const parseSteer =
      isJsxGenericParse && file.endsWith(".ts") && !file.endsWith(".d.ts")
        ? " This `'>' expected` in a `.ts` is usually JSX in a non-JSX file — if it contains JSX, it must be a `.tsx` (a `.ts` parses `<X>` as a generic and demands `>`)."
        : "";

    return `${message}\n↳ SYNTAX/PARSE error — do NOT surgically patch it (a patch on a broken-parse file re-breaks its braces/generics/JSX). REWRITE THE WHOLE FILE \`${file}\` cleanly in one pass; once it parses, downstream errors clear.${parseSteer}`;
  }

  // Real tsc output (from build logs) is the ABBREVIATED form: `Type 'Readable<SuccessResponse<...>>'
  // is not assignable to type 'ICompanyItem[]'` — tsc prints `<...>` for the deep inner, so we match
  // on `Readable<SuccessResponse` broadly. KEY: after `const { data } = await apiClient.GET(...)`, the
  // FetchResponse is already stripped; `data`'s type is whatever generate:api produced for this path.
  // In the green scaffold `data` IS the domain type and `return data ?? []` works. Seeing `data` typed
  // `Readable<SuccessResponse<...>>` means generate:api did NOT resolve it to your domain type — an
  // UPSTREAM problem (response schema / path / stale types); `?? []`, a guard, or `as` cannot convert
  // the wrapper into the domain type, so the fix is upstream, then use the scaffold's consumer shape.
  if (message.includes("Readable<SuccessResponse")) {
    return `${message}\n↳ \`data\` here is typed \`Readable<SuccessResponse<...>>\` (openapi-fetch's response wrapper), NOT your domain type — so \`generate:api\` did not resolve this path's response to \`I<Item>\`. \`?? []\`, a nullish guard, and \`as\` only touch null/undefined; NONE of them turns the wrapper into \`I<Item>\` — the exact error will remain. FIX UPSTREAM so \`data\` resolves to your domain type — the mismatch is between the route's \`response:\` schema and your item type, not the consumer: (1) the API route needs a \`response:\` TypeBox schema that matches what the service returns AND your \`I<Item>\` shape — list → \`t.Array(<ItemSchema>)\`, get-one/create/update → \`<ItemSchema>\`, delete → \`t.Null()\` (a nullable column is \`t.Optional(t.Union([t.String(), t.Null()]))\`, not \`t.Optional(t.String())\`); (2) if you just changed that schema, the generated types are stale — the gate re-runs \`generate:api\` next cycle from /swagger/json, so get the schema right and let it regenerate. (A wrong PATH surfaces separately as a \`PathsWithMethod\` error, not this one — don't chase the path here.) THEN, with \`data\` resolved, use the scaffold's consumer shape verbatim (\`features/accounts/JoinRequests.*\`): a LIST is \`UseQueryResult<IXItem[]>\` + \`return data ?? []\`; a CREATE/UPDATE is \`UseMutationResult<IXItem, unknown, Vars>\` and returns the item to MATCH ITS ROUTE — a direct \`response: <Item>\` route guards then \`return data\`, an enveloped \`response: t.Object({ data: <Item> })\` route reads \`return data.data\` (guard \`if (!data?.data) throw\`); a DELETE is \`UseMutationResult<void, unknown, string>\` → \`await apiClient.DELETE(…)\`. Keep the annotations. NEVER \`as\`-cast and NEVER "remove the annotation and let TS infer" — both are dead ends the scaffold does not use.`;
  }

  // A `PathsWithMethod<paths, …>` error means the path STRING doesn't match any generated key —
  // three causes, call-site first (build12/build14 evidence in the message below).
  if (message.includes("PathsWithMethod")) {
    return `${message}\n↳ \`PathsWithMethod<…, "<verb>">\` means no generated key matches this path AND method. Three causes — check the call site FIRST (generate:api fixes NEITHER of the first two): (1) WRONG PATH string — the literal must EXACTLY match a generated key: the COLLECTION root carries a TRAILING SLASH (list/create are \`/api/v1/<resource>/\`, e.g. \`POST "/api/v1/<resource>/"\` — a POST/GET to \`/api/v1/<resource>\` WITHOUT the slash is the usual cause here; ADD it), while by-id is \`/api/v1/<resource>/{id}\` (no trailing slash) with a literal \`{id}\` segment, value via \`{ params: { path: { id } } }\`, never interpolated; \`/api/x\` or \`/x\` (missing the \`/api/v1/\` prefix) is also wrong; (2) WRONG VERB — the path exists but doesn't support this method (e.g. a GET-only path called with POST); call the method the route actually defines; (3) ONLY if path AND verb are already right is the route genuinely unregistered — ensure it exists AND is mounted (shows in /swagger/json), then the gate re-runs generate:api and the type appears. Do NOT re-run generate:api for a call-site (path/verb) bug.`;
  }

  return message;
}

/** Preserve the failing app's section when an unfamiliar tool format defeats the
 * parser. The old first-500-character fallback showed the preceding healthy API
 * build and hid the actual UI failure later in the output. */
function opaqueGateError(output: string, cwd: string): IErrorItem {
  const markers = [...output.matchAll(/^::tsforge-app (.+)::$/gmu)];
  const last = markers.at(-1);
  const app = last?.[1] ?? "";
  const start = last?.index ?? 0;
  const section = output.slice(start).split(cwd).join("").trim();
  const excerpt =
    section.length <= 3_000
      ? section
      : `${section.slice(0, 1_800)}\n… output truncated …\n${section.slice(-1_000)}`;
  const phase =
    app === "apps/api"
      ? 1
      : app === "apps/ui"
        ? 2
        : app === "."
          ? 3
          : undefined;

  return {
    key: `gate-nonzero:${app === "" ? "unknown" : app}`,
    ...(phase === undefined ? {} : { phase }),
    message: `Gate exited nonzero${app === "" ? "" : ` in ${app}`} and its output format was not recognized:\n${excerpt}`,
  };
}

/**
 * The command stage: apply BoringStack's deterministic auto-fixes, sync the DB to
 * whatever columns the model just added, then run the composed `validate && check`
 * gate. Auto-fix + db:push run EVERY cycle here (what a dev gets on save) so those
 * never cost the model a gate attempt. On failure each parsed failure SIGNATURE
 * becomes an `IErrorItem` whose `key` IS the signature — so the differential
 * wrapper can suppress baseline signatures and `checkStuck` can fingerprint them.
 */
/** Cap the pinpoint detail; longer messages get an explicit truncation marker (never silent). */
const PARSE_DETAIL_CAP = 200;
const PARSE_TRUNCATION_MARKER = "…(truncated)";

/**
 * Report the FIRST genuine SYNTAX error in one source file, or null if it parses.
 *
 * Uses `Program.getSyntacticDiagnostics` — syntax-only BY CONTRACT (no type-checking, no
 * semantic/`isolatedModules` diagnostics), so it agrees exactly with what typescript-eslint's
 * parser reports as a "Parsing error". A file that is valid TypeScript — `const enum`,
 * `import type`, a `<T,>` generic — is NEVER falsely fingered (`transpileModule` would flag
 * some of these; the parser will not). The program is single-file and in-memory (`noLib` +
 * `noResolve`), so no lib/type resolution runs. Returns `line L:C — <message>`, truncation-marked.
 */
function firstSyntaxError(code: string, fileName: string): string | null {
  const scriptKind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    scriptKind
  );

  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: () => undefined,
  };

  const program = ts.createProgram(
    [fileName],
    {
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      noLib: true,
      noResolve: true,
    },
    host
  );

  // getSyntacticDiagnostics returns DiagnosticWithLocation (file + start guaranteed) and is
  // syntax-only by contract — the first entry, if any, is the genuine parse error.
  const diag = program.getSyntacticDiagnostics(sourceFile)[0];

  if (diag === undefined) {
    return null;
  }

  const { line, character } = diag.file.getLineAndCharacterOfPosition(
    diag.start
  );
  const message = ts.flattenDiagnosticMessageText(diag.messageText, " ");
  const detail = `line ${line + 1}:${character + 1} — ${message}`;

  return detail.length > PARSE_DETAIL_CAP
    ? `${detail.slice(0, PARSE_DETAIL_CAP)}${PARSE_TRUNCATION_MARKER}`
    : detail;
}

/** True if `file` (repo-relative) falls under any of the scope globs the model may edit. */
function fileInScope(file: string, scopeGlobs: readonly string[]): boolean {
  return scopeGlobs.some((glob) => new Bun.Glob(glob).match(file));
}

/** First syntax error in one file, or null — swallowing ANY throw (unreadable file, parser/program
 *  error) so a single bad file skips ONLY itself and the scan keeps going to later files. */
async function safeFirstSyntaxError(
  absPath: string,
  fileName: string
): Promise<string | null> {
  try {
    return firstSyntaxError(await Bun.file(absPath).text(), fileName);
  } catch {
    return null;
  }
}

/** Which app section(s) of the composed-gate output actually show the `parserOptions.project`
 *  cascade — so the locator scans the app that FAILED, not blindly apps/api then apps/ui. The
 *  output echoes `::tsforge-app <app>::` before each app's stages (see gate.ts). Empty when no
 *  section matches → enrichUnparsable stays a silent no-op (there is NO both-apps fallback: we do
 *  not guess an app the output didn't implicate). */
function appsWithParseCascade(output: string): string[] {
  const parts = output.split(/::tsforge-app (\S+)::/u);
  const apps: string[] = [];

  // split with a capture group yields [pre, app1, body1, app2, body2, …].
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const app = parts[i] ?? "";
    const body = parts[i + 1] ?? "";

    if (
      (app === "apps/api" || app === "apps/ui") &&
      /parserOptions\.project|ESLint was configured to run on/u.test(body)
    ) {
      apps.push(app);
    }
  }

  return apps;
}

/**
 * Pinpoint the ONE file with a real syntax error behind an `eslint-program-unparsable` cascade.
 * The type-aware ESLint program fails to build off a single broken file yet fans a
 * `parserOptions.project` parse error across EVERY file, so its output can't say which file is
 * actually broken — and the model thrashes near-green hunting for it. Re-parse each source file
 * in ISOLATION with the TypeScript parser (`firstSyntaxError`) and return the first genuinely
 * malformed one that PASSES `isRewritable` (repo-relative) + its located message. Same parser as
 * the lint, so it cannot mis-name a healthy file. `appsToScan` is the app(s) whose gate section
 * actually showed the cascade — so a UI cascade is never mis-attributed to an unrelated API syntax
 * error. `isRewritable` is applied DURING the scan (not to a single first hit): a broken file the
 * model can't rewrite is skipped and the scan continues, so a later rewritable broken file is still
 * found. Scans `{src,tests}` (feature scope includes `apps/api/tests/…`). Best-effort; never throws.
 */
export async function locateParseError(
  cwd: string,
  appsToScan: readonly string[],
  isRewritable: (repoRelPath: string) => boolean
): Promise<{ file: string; detail: string } | null> {
  for (const app of appsToScan) {
    const root = join(cwd, app);

    try {
      const glob = new Bun.Glob("{src,tests}/**/*.{ts,tsx}");

      for await (const rel of glob.scan({ cwd: root })) {
        const file = `${app}/${rel}`;

        if (!isRewritable(file)) {
          continue;
        }

        const detail = await safeFirstSyntaxError(join(root, rel), rel);

        if (detail !== null) {
          return { file, detail };
        }
      }
    } catch {
      // glob/scan setup failure is non-fatal — enrichUnparsable still fails safe below.
    }
  }

  return null;
}

/**
 * APPEND a high-confidence pointer to the file-less `eslint-program-unparsable` message — and ONLY
 * a high-confidence one. We do NOT try to reconstruct ESLint's project graph; we add a hint only
 * when all of these hold, otherwise we stay silent and leave the (generic) base message intact:
 *   • the cascade was attributed to a specific failing app (`appsToScan` non-empty), AND
 *   • a FEATURE-OWNED file (a dir the model may fully rewrite — never a shared add-only file) in
 *     that app has a GENUINE syntax error (getSyntacticDiagnostics — never a config/inclusion
 *     error, so a `parserOptions.project` message that is really a TSConfig problem is never
 *     mis-labelled a syntax error).
 * The hint is APPEND-ONLY and AGREES with the base ("find the broken file and rewrite it"), so it
 * can never contradict it; it names only a feature-owned file (no ownership bypass, no shared-file
 * clobber); it never mutates `.file`/phase (no file-vs-phase disagreement). The wording makes NO
 * "this is the only broken file / the cascade will fully clear" claim — with two or more broken
 * files that would mis-steer — it states the true, useful fact: this owned file has a real syntax
 * error and must be fixed (and there may be more). When any condition fails, the base stands.
 */
async function enrichUnparsable(
  unparsable: IErrorItem,
  cwd: string,
  rewritableGlobs: readonly string[],
  appsToScan: readonly string[]
): Promise<void> {
  if (appsToScan.length === 0 || rewritableGlobs.length === 0) {
    return;
  }

  const located = await locateParseError(cwd, appsToScan, (file) =>
    fileInScope(file, rewritableGlobs)
  );

  if (located === null) {
    return;
  }

  unparsable.message +=
    ` → A real syntax error is in \`${located.file}\` (${located.detail}), a file you own — fix ` +
    `it (there may be more than one broken file; every one must parse before the cascade clears).`;
}

export function boringstackCommandStage(
  cwd: string,
  exec: Exec,
  rewritableGlobs: readonly string[] = []
): IStage {
  return {
    async run(): Promise<IValidateResult> {
      await autofixApps(cwd, exec);
      await exec(["bun", "run", "db:push", "--", "--force"], {
        cwd: join(cwd, "apps/api"),
      });

      const result = await runBoringstackGate(cwd, exec);

      if (result.passed) {
        return { passed: true, errors: [], output: result.output };
      }

      const signatures = [...extractFailures(result.output, cwd)];
      const errors: IErrorItem[] =
        signatures.length > 0
          ? signatures.map(signatureToError)
          : [opaqueGateError(result.output, cwd)];

      // If the whole type-aware program failed to parse, name the actual broken file (ESLint's
      // cascade can't) so the model rewrites THAT file instead of thrashing near-green hunting it.
      const unparsable = errors.find(
        (e) => e.rule === "eslint-program-unparsable"
      );

      if (unparsable !== undefined) {
        // Scan ONLY the app(s) whose gate section showed the cascade — never mis-attribute a UI
        // cascade to an unrelated API syntax error. If we can't attribute it to an app, we do NOT
        // guess (no both-apps fallback): enrichUnparsable stays a silent no-op and the base
        // guidance stands.
        await enrichUnparsable(
          unparsable,
          cwd,
          rewritableGlobs,
          appsWithParseCascade(result.output)
        );
      }

      return { passed: false, errors, output: result.output };
    },
  };
}

/**
 * A feature isn't "done" just because it COMPILES — it must be reachable and
 * usable. This stage runs the static reachability check (route wired, API mounted,
 * i18n keys present); a failure becomes one gate error the loop can escalate on.
 */
export function reachabilityStage(cwd: string, featureId: string): IStage {
  return {
    async run(): Promise<IValidateResult> {
      const reach = await verifyFeatureReachable(cwd, featureId);

      if (reach.ok) {
        return { passed: true, errors: [], output: "reachable" };
      }

      const message =
        `"${featureId}" is not reachable/usable:\n- ` +
        reach.problems.join("\n- ");

      return {
        passed: false,
        errors: [
          { key: `reachability:${featureId}`, rule: "reachability", message },
        ],
        output: message,
      };
    },
  };
}

/**
 * The reject-by-default quality judge as a gate stage. Its prose rejection becomes
 * ONE gate error: `rule: "judge"`, `file` = the resource's service file (via
 * `rescueFileFor`) so the fingerprint is stable across repeated judge rejections on
 * the same feature and the expert (R4) can resolve a file to hand off.
 */
export function judgeStage(
  evaluator: IProvider,
  cwd: string,
  feature: IFeature,
  siblingEntities: readonly string[] = []
): IStage {
  return {
    async run(): Promise<IValidateResult> {
      const code = await readResourceCode(cwd, feature.id);
      const verdict = await judgeFeature(evaluator, {
        feature: feature.desc,
        code,
        // The other slices' entities: the judge must not reject THIS feature for
        // lacking a cross-slice link a later slice owns (the relational-collision bug).
        siblingEntities: [...siblingEntities],
      });

      if (verdict.ok) {
        return { passed: true, errors: [], output: "judge: pass" };
      }

      const file = await rescueFileFor(cwd, feature);
      const message = `judge rejected "${feature.id}": ${verdict.notes}`;

      return {
        passed: false,
        errors: [
          {
            key: `judge:${feature.id}`,
            rule: "judge",
            ...(file === null ? {} : { file }),
            message,
          },
        ],
        output: message,
      };
    },
  };
}

/**
 * A change-scoped gate stage that ensures a feature's UI includes the required
 * test ID attributes (data-testid) for end-to-end testing. Only runs when a
 * feature's UI files are present.
 */
export function testIdStage(cwd: string, entity: IEntityAcceptance): IStage {
  return {
    async run(): Promise<IValidateResult> {
      const featureDir = join(cwd, "apps/ui/src/features", entity.key);

      // Scan recursively for ALL UI source files (.tsx and .jsx)
      const sources = new Map<string, string>();

      try {
        const files = await readdir(featureDir, { recursive: true });
        const uiFiles = files.filter(
          (f): f is string =>
            typeof f === "string" && (f.endsWith(".tsx") || f.endsWith(".jsx"))
        );

        for (const file of uiFiles) {
          const filePath = join(featureDir, file);
          const content = await readFile(filePath, "utf-8");

          sources.set(file, content);
        }
      } catch {
        // Directory doesn't exist or can't be read — check if there's a route for this feature
        // If the route file doesn't exist yet, the UI hasn't been scaffolded (pass silently).
        // If it does exist, that's a fatal error — the UI was generated but source is missing.
        const routeFile = join(cwd, "apps/ui/src/routes", `${entity.key}.tsx`);

        try {
          await readFile(routeFile, "utf-8");

          // Route exists but feature dir is unreadable/missing — this is an error
          return {
            passed: false,
            errors: [
              {
                key: `testid:${entity.id}`,
                rule: "testid-presence",
                message: `feature '${entity.id}' has a route but the feature directory is missing or unreadable: ${featureDir}`,
              },
            ],
            output: `route exists but feature dir missing: ${featureDir}`,
          };
        } catch {
          // Route doesn't exist either — UI hasn't been scaffolded yet, pass silently
          return { passed: true, errors: [], output: "no UI files to check" };
        }
      }

      // No UI files found
      if (sources.size === 0) {
        // Check if the route file exists — if so, UI was generated but is empty (error)
        const routeFile = join(cwd, "apps/ui/src/routes", `${entity.key}.tsx`);

        try {
          await readFile(routeFile, "utf-8");

          // Route exists but no source files in feature dir — that's suspicious
          return {
            passed: false,
            errors: [
              {
                key: `testid:${entity.id}`,
                rule: "testid-presence",
                message: `feature '${entity.id}' has a route but no UI source files in ${featureDir}`,
              },
            ],
            output: `route exists but no UI source files`,
          };
        } catch {
          // Route doesn't exist — UI truly hasn't been scaffolded yet, pass silently
          return { passed: true, errors: [], output: "no UI files to check" };
        }
      }

      // Check for required testids
      const missing = checkTestIds(sources, entity);

      if (missing.length === 0) {
        return { passed: true, errors: [], output: "all testids present" };
      }

      const message =
        `feature '${entity.id}' UI is missing required test hooks: ${missing.join(", ")}. ` +
        `Add data-testid to the list, form, fields, and row controls so the app is testable.`;

      return {
        passed: false,
        errors: [
          {
            key: `testid:${entity.id}`,
            rule: "testid-presence",
            message,
          },
        ],
        output: message,
      };
    },
  };
}

/**
 * Compose the full BoringStack gate: differential command (suppress baseline) →
 * reachability → testid → judge. Short-circuited, so the model call (judge) fires
 * only when the code compiles/lints clean AND the feature is reachable. Baseline
 * lives in the differential wrapper's closure — captured once at build start.
 */
export function composeBoringstackGate(opts: {
  cwd: string;
  exec: Exec;
  evaluator: IProvider;
  baseline: ReadonlySet<string>;
  feature: IFeature;
  /** The acceptance spec for this feature's entity (if available).
   *  Passed to testIdStage to enforce the full per-entity contract. */
  entity?: IEntityAcceptance;
  /** The OTHER features/entities in this build, so the judge scopes to this
   *  feature's own responsibilities and never demands a link to an unbuilt slice. */
  siblingEntities?: readonly string[];
}): IGate {
  const { cwd, exec, evaluator, baseline, feature, entity } = opts;
  const e2eAcceptanceDisabled =
    process.env[ENV_FLAG.noE2eAcceptance] === FLAG_ON;

  // The parse-error locator may only name a file the model can FULLY rewrite — its feature-owned
  // dirs, NOT the shared add-only files (schema/locale/sidebar/routes). Derived here from the
  // feature (no wiring to forget, no shared-file clobber).
  const rewritableGlobs = featureOwnedGlobs(feature.id);

  return composeGate([
    differentialStage(
      boringstackCommandStage(cwd, exec, rewritableGlobs),
      baseline
    ),
    reachabilityStage(cwd, feature.id),
    ...(entity !== undefined && !e2eAcceptanceDisabled
      ? [testIdStage(cwd, entity)]
      : []),
    judgeStage(evaluator, cwd, feature, opts.siblingEntities ?? []),
  ]);
}
