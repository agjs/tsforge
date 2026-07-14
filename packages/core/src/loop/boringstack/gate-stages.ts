import { join } from "node:path";
import type { IGate, IStage } from "../../gate/gate-runner";
import { composeGate, differentialStage } from "../../gate/gate-runner";
import type { IValidateResult } from "../../validate";
import type { IProvider } from "../../inference";
import type { IFeature } from "../greenfield/greenfield.types";
import type { Exec } from "./exec";
import { runBoringstackGate } from "./gate";
import { extractFailures } from "./extract-failures";
import { verifyFeatureReachable } from "./reachability";
import { judgeFeature } from "../greenfield/judge";
import { autofixApps, readResourceCode, rescueFileFor } from "./build";

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
      const errors =
        signatures.length > 0
          ? signatures.map((sig) => ({ key: sig, message: sig }))
          : [{ key: "gate-nonzero", message: result.output.slice(0, 500) }];

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
  feature: IFeature
): IStage {
  return {
    async run(): Promise<IValidateResult> {
      const code = await readResourceCode(cwd, feature.id);
      const verdict = await judgeFeature(evaluator, {
        feature: feature.desc,
        code,
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
}): IGate {
  const { cwd, exec, evaluator, baseline, feature } = opts;

  return composeGate([
    differentialStage(boringstackCommandStage(cwd, exec), baseline),
    reachabilityStage(cwd, feature.id),
    judgeStage(evaluator, cwd, feature),
  ]);
}
