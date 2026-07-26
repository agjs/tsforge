import type { IProvider } from "../../inference";
import type { Reporter } from "../loop.types";
import type { EditGuard } from "../tools";
import { Session } from "../session";
import { BORINGSTACK_BUILD_SESSION } from "./build-config";

/** Runtime inputs the caller (the headless driver) supplies; the fixed BoringStack
 *  build flags come from {@link BORINGSTACK_BUILD_SESSION}. */
export interface IBoringstackHostDeps {
  provider: IProvider;
  cwd: string;
  contextWindow: number;
  maxTurns: number;
  report: Reporter;
  editGuard: EditGuard;
  /** Sampling temperature for the build session. Omitted → the session default
   *  (DEFAULT_TEMPERATURE, 0.2). DeepSeek's thinking mode wants ~1.0 to avoid CoT
   *  collapse / repetitive reasoning loops; exposed so the headless driver can set it
   *  (e.g. from TSFORGE_BUILD_TEMPERATURE) for the temperature A/B on the near-green
   *  rotation without touching the loop. */
  temperature?: number;
}

/**
 * The SINGLE constructor for the BoringStack build's host Session. The headless
 * driver calls exactly this — so the fixed build flags (drive-to-green, guidance,
 * pull_conventions, and the WS-G `check` tool) can't drift or be silently dropped by
 * a re-inlined `Session.create`, and a test can assert the resulting session actually
 * advertises `check` (closing the gap a Session-only test or a const-only pin leaves).
 */
export function createBoringstackHostSession(
  deps: IBoringstackHostDeps
): Promise<Session> {
  return Session.create({
    provider: deps.provider,
    cwd: deps.cwd,
    files: ["**/*"],
    contextWindow: deps.contextWindow,
    maxTurns: deps.maxTurns,
    ...BORINGSTACK_BUILD_SESSION,
    ...(deps.temperature === undefined
      ? {}
      : { temperature: deps.temperature }),
    editGuard: deps.editGuard,
    report: deps.report,
  });
}
