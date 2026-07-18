import { join } from "node:path";
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
      message,
    };
  }

  return { key: sig, message: sig };
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
 * Compose the full BoringStack gate: differential command (suppress baseline) →
 * reachability → judge. Short-circuited, so the model call (judge) fires only when
 * the code compiles/lints clean AND the feature is reachable. Baseline lives in the
 * differential wrapper's closure — captured once at build start.
 */
export function composeBoringstackGate(opts: {
  cwd: string;
  exec: Exec;
  evaluator: IProvider;
  baseline: ReadonlySet<string>;
  feature: IFeature;
  /** The OTHER features/entities in this build, so the judge scopes to this
   *  feature's own responsibilities and never demands a link to an unbuilt slice. */
  siblingEntities?: readonly string[];
}): IGate {
  const { cwd, exec, evaluator, baseline, feature } = opts;

  return composeGate([
    differentialStage(boringstackCommandStage(cwd, exec), baseline),
    reachabilityStage(cwd, feature.id),
    judgeStage(evaluator, cwd, feature, opts.siblingEntities ?? []),
  ]);
}
