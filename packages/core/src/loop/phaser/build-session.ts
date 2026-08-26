import type { IProvider } from "../../inference";
import type { Reporter } from "../loop.types";
import { Session } from "../session";
import { PHASER_BUILD_SESSION } from "./build-config";
import { phaserContextBrief } from "./context-brief";

export interface IPhaserHostDeps {
  provider: IProvider;
  cwd: string;
  contextWindow: number;
  maxTurns: number;
  report: Reporter;
  activePlanId?: string | null;
}

/**
 * Host Session for a Phaser slice drive. Spreads PHASER_BUILD_SESSION so
 * drive-to-green + conventions + check + policy deny cannot silently drop.
 */
export async function createPhaserHostSession(
  deps: IPhaserHostDeps
): Promise<Session> {
  const brief = await phaserContextBrief(deps.cwd);

  return Session.create({
    provider: deps.provider,
    cwd: deps.cwd,
    files: ["**/*"],
    contextWindow: deps.contextWindow,
    maxTurns: deps.maxTurns,
    ...PHASER_BUILD_SESSION,
    guidance: `${brief}\n\n${PHASER_BUILD_SESSION.guidance}`,
    report: deps.report,
    offerTaskTools: true,
    ...(typeof deps.activePlanId === "string" && deps.activePlanId.length > 0
      ? { activePlanId: deps.activePlanId }
      : {}),
  });
}
