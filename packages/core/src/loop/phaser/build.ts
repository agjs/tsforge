import type { IGate } from "../../gate/gate-runner";
import type { PhaserProductPlan, IPhaserViewIntent } from "./plan-extension";
import type { ISlice } from "../planning/plan-types";
import { generateSlice } from "./generate";
import { wireSlice } from "./wire";
import type { Exec } from "./exec";
import { PHASER_SLICE_GUIDANCE } from "./build-config";

export interface IPhaserHost {
  setScope(globs: string[]): void;
  setGate(gate: string | IGate): void;
  send(message: string): Promise<{ status: string; turns: number }>;
}

export interface IPhaserBuildResult {
  readonly status: "done" | "parked" | "needs-plan";
  readonly completed: readonly string[];
  readonly parked: string | null;
}

function unique(paths: readonly string[]): string[] {
  const out: string[] = [];

  for (const p of paths) {
    if (!out.includes(p)) {
      out.push(p);
    }
  }

  return out;
}

function slicePrompt(slice: ISlice<IPhaserViewIntent>): string {
  return (
    `${PHASER_SLICE_GUIDANCE}\n\n` +
    `Slice: kind=${slice.ui.kind} entity=${slice.entity.id} scene=${slice.ui.scene}.\n` +
    `${slice.entity.desc}\n` +
    `Must remain true: ${slice.verification.mustRemainTrue.join("; ")}.\n` +
    `Must not happen: ${slice.verification.mustNotHappen.join("; ")}.`
  );
}

export async function runPhaserBuild(opts: {
  cwd: string;
  plan: PhaserProductPlan;
  host: IPhaserHost;
  exec: Exec;
  echo?: (s: string) => void;
  generate?: typeof generateSlice;
  wire?: typeof wireSlice;
  runSmoke?: boolean;
}): Promise<IPhaserBuildResult> {
  const generate = opts.generate ?? generateSlice;
  const wire = opts.wire ?? wireSlice;
  const echo = opts.echo ?? ((): void => undefined);
  const completed: string[] = [];

  if (opts.plan.slices.length === 0) {
    return { status: "done", completed, parked: null };
  }

  for (const slice of opts.plan.slices) {
    echo(`▸ generating ${slice.ui.kind} ${slice.entity.id}\n`);

    const generated = await generate(opts.cwd, slice, opts.exec);
    const wired = await wire(opts.cwd, slice, opts.exec);

    await opts.exec(["bun", "run", "format"], { cwd: opts.cwd });

    const scope = unique([...generated.paths, ...wired.paths]);

    opts.host.setScope(scope.length > 0 ? scope : generated.paths.slice());
    opts.host.setGate("bun run check");

    const sent = await opts.host.send(slicePrompt(slice));

    if (sent.status !== "done") {
      echo(`▸ parked ${slice.entity.id} (${sent.status})\n`);

      return {
        status: "parked",
        completed,
        parked: slice.entity.id,
      };
    }

    if (opts.runSmoke === true) {
      const smoke = await opts.exec(["bun", "run", "test:smoke"], {
        cwd: opts.cwd,
      });

      if (smoke.code !== 0) {
        echo(`▸ smoke failed for ${slice.entity.id}\n`);

        return {
          status: "parked",
          completed,
          parked: slice.entity.id,
        };
      }
    }

    completed.push(slice.entity.id);
  }

  return { status: "done", completed, parked: null };
}
