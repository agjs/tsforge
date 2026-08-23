import type { IGate } from "../gate/gate-runner";
import type { ISendOptions } from "../loop/session";
import type { IPhaserHost } from "../loop/phaser/build";
import { focusPlanItemByTitle } from "../loop/worklist/checklist-store";
import type { IPlanDocument } from "../loop/worklist/checklist.types";

/** The Session methods Phaser approve actually needs — not a second Session. */
export interface IPhaserReplSession {
  setScope(globs: string[]): void;
  setGate(gate: string | IGate): void;
  send(
    message: string,
    opts?: ISendOptions
  ): Promise<{ status: string; turns: number }>;
  getActivePlanId(): string | null;
}

/**
 * Drive `runPhaserBuild` on the live REPL session so the Tasks rail, abort
 * signal, and status spinner share one `activePlanId`.
 */
export function phaserHostFromSession(
  session: IPhaserReplSession,
  opts: {
    readonly cwd: string;
    sendOpts?: () => ISendOptions | undefined;
    onPlanChanged?: (plan: IPlanDocument) => void;
  }
): IPhaserHost {
  return {
    setScope: (globs) => {
      session.setScope(globs);
    },
    setGate: (gate) => {
      session.setGate(gate);
    },
    send: (message, sendOpts) => {
      const fromDrive = opts.sendOpts?.();

      return session.send(message, {
        ...(fromDrive ?? {}),
        ...(sendOpts ?? {}),
      });
    },
    focusItem: (title) => {
      const planId = session.getActivePlanId();

      if (planId === null) {
        return;
      }

      const plan = focusPlanItemByTitle(opts.cwd, planId, title);

      if (plan !== null) {
        opts.onPlanChanged?.(plan);
      }
    },
  };
}
