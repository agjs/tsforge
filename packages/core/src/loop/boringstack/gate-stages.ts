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
import { autofixApps, readResourceCode, rescueFileFor } from "./build";
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
        "The TypeScript-aware lint could not build its program: ONE file has a real " +
        "syntax/parse error (`Parsing error: … expected`), which makes ESLint report a " +
        "`parserOptions.project` parse error on EVERY .tsx file. This is ONE broken " +
        "file, not many separate errors — do NOT chase the per-file parse errors. Find " +
        "the file with the actual `Parsing error: … expected` and REWRITE IT IN FULL " +
        "(a surgical patch on an already-broken file usually re-breaks its braces/" +
        "generics). Once that file parses, the whole cascade clears at once.",
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

  // `Readable<SuccessResponse<…>>` is Elysia+openapi-fetch's UNIVERSAL response type (swagger
  // emits json+multipart+text for EVERY route, scaffold ones included) — NOT a route/schema bug.
  // The model burned ~60 turns (build15) chasing it on the API side; steer to the consumer.
  if (message.includes("Readable<SuccessResponse")) {
    return `${message}\n↳ \`Readable<SuccessResponse<…>>\` is the api-client's NORMAL, UNIVERSAL response type — Elysia's swagger emits three media types (json/multipart/text) for EVERY route (the scaffold's own auth/dashboard routes are identical), so you CANNOT remove it by editing the route or the \`response:\` schema — do NOT try. Fix it on the CONSUMER by INFERRING, not annotating — it shows up two ways, BOTH fixed by removing an annotation (never \`as\`-cast): (a) \`not assignable to Promise<IEntity>\` = you annotated the \`.queries.ts\`/\`.mutations.ts\` fn \`: Promise<IEntity>\` with a bare \`return data\`; (b) \`UseMutationResult<Readable<…>> not assignable to UseMutationResult<IEntity>\` (or \`UseQueryResult\`) = you annotated the HOOK generic/return (\`useMutation<IEntity>\` / \`: UseMutationResult<IEntity>\`). REMOVE the annotation on the fn AND the hook and let TS INFER both. Then return the payload for THIS route's response shape: if it wraps \`{ data: … }\` (scaffold auth pattern) read \`data?.data\`; if it returns the object/array directly, just \`return data\` — match your \`response:\` schema, don't blindly add \`.data\`.`;
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
 * Report the FIRST genuine syntax error in one source file, or null if it parses.
 * Uses the TypeScript compiler's own parser (`transpileModule`, syntax-only — it does NO
 * type-checking) so this agrees with typescript-eslint's parser: a file that is valid TS is
 * NEVER falsely fingered. Global option diagnostics (no `file`) are ignored — only located,
 * in-file parse errors count. Returns `line L:C — <message>` (truncation-marked, never silent).
 */
function firstSyntaxError(code: string, fileName: string): string | null {
  const out = ts.transpileModule(code, {
    reportDiagnostics: true,
    fileName,
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
  });

  const diag = (out.diagnostics ?? []).find(
    (d) =>
      d.category === ts.DiagnosticCategory.Error &&
      d.file !== undefined &&
      d.start !== undefined
  );

  if (diag?.file === undefined || diag.start === undefined) {
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

/**
 * Pinpoint the ONE file with a real syntax error behind an `eslint-program-unparsable` cascade.
 * The type-aware ESLint program fails to build off a single broken file yet fans a
 * `parserOptions.project` parse error across EVERY .tsx, so its output can't say which file is
 * actually broken — and the model thrashes near-green hunting for it. Re-parse each source file
 * in ISOLATION with the TypeScript parser (`firstSyntaxError`) and return the first genuinely
 * malformed one (repo-relative) + its located message. Same parser as the lint, so it cannot
 * mis-name a healthy file. Because there are no false positives, the apps/api-before-ui scan
 * order is harmless — if both apps hold a real syntax error, either is a correct thing to fix.
 * Best-effort and fast (only runs on the rare cascade). Never throws.
 */
export async function locateParseError(
  cwd: string
): Promise<{ file: string; detail: string } | null> {
  for (const app of ["apps/api", "apps/ui"]) {
    const root = join(cwd, app);

    try {
      const glob = new Bun.Glob("src/**/*.{ts,tsx}");

      for await (const rel of glob.scan({ cwd: root })) {
        let code: string;

        try {
          code = await Bun.file(join(root, rel)).text();
        } catch {
          continue;
        }

        const detail = firstSyntaxError(code, rel);

        if (detail !== null) {
          return { file: `${app}/${rel}`, detail };
        }
      }
    } catch {
      // glob/scan failure is non-fatal — the base message still guides the model.
    }
  }

  return null;
}

export function boringstackCommandStage(cwd: string, exec: Exec): IStage {
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
        const located = await locateParseError(cwd);

        if (located !== null) {
          unparsable.message +=
            ` → The parse failure is in \`${located.file}\` (${located.detail}). ` +
            `Fix the syntax error there — rewrite that file in full if the cause is not obvious. ` +
            `This is the one file blocking the whole type-aware gate; if it is outside your ` +
            `current feature, it is still the file to fix.`;
        }
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

  return composeGate([
    differentialStage(boringstackCommandStage(cwd, exec), baseline),
    reachabilityStage(cwd, feature.id),
    ...(entity !== undefined && !e2eAcceptanceDisabled
      ? [testIdStage(cwd, entity)]
      : []),
    judgeStage(evaluator, cwd, feature, opts.siblingEntities ?? []),
  ]);
}
