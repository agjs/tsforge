import type { IConventionProvider } from "../conventions-provider";
import type { IPlanConstraints, IPlanSchema } from "./plan-types";

/**
 * A STACK adapter as the generic planner/CLI sees it. The core greenfield flow knows
 * only this interface — it never names a concrete stack. An adapter answers two
 * questions for a project directory:
 *   - `detect(dir)`: is this project mine? (e.g. a scaffold receipt)
 *   - `planConstraints(onStripped)`: the stack-specific planner constraints (guidance +
 *     reserved-entity stripping), fail-closed via `IPlanConstraints`.
 * Concrete adapters (BoringStack, Phaser) live under their own adapter directory and
 * are registered by the composition root (the CLI), never imported by core planning logic.
 */
export interface IStackAdapter {
  /** Stable id, e.g. "boringstack" — used in surfaced messages, not for control flow. */
  readonly id: string;
  /** Whether this adapter owns the project at `dir` (authoritative, no false positives). */
  detect(dir: string): Promise<boolean>;
  /**
   * The stack's planner constraints. `IPlanConstraints` is fail-closed at the TYPE level:
   * `reservedEntities` can only be set together with SOME `onStripped`, so a strip is never
   * silently dropped. The type cannot force an adapter to forward the CALLER's `onStripped`
   * (an adapter could attach its own) — that it forwards the passed reporter to the caller's
   * sink is the adapter's contract, verified per-adapter by test (see stack-adapter.test.ts).
   */
  planConstraints(
    onStripped: (droppedEntityIds: readonly string[]) => void
  ): IPlanConstraints;
  /**
   * The stack's plan schema (prompt + UI validator + cross-slice rule), TYPE-ERASED to
   * `IPlanSchema<unknown>` so a heterogeneous adapter registry is well-typed. The greenfield flow
   * drives the planner + parses/loads plans through THIS schema (so a project is planned and
   * validated by the adapter that detected it — not a hardcoded stack). The adapter keeps a
   * concretely-typed schema for its own build path; this is the same runtime schema, erased.
   */
  readonly planSchema: IPlanSchema<unknown>;
  /** Optional write-time convention library. Absent → the session carries none. */
  readonly conventions?: IConventionProvider;
  /**
   * Optional session-start map so the model does not walk the tree to "understand"
   * a project this adapter already knows. Injected as `ISessionConfig.guidance`.
   * Absent → today's thin start (topic names + empty `/map`).
   */
  contextBrief?(dir: string): Promise<string>;
}

/**
 * Resolve the FIRST registered adapter that claims the project at `dir`, or null if none
 * do (a plain/unknown project — no stack-specific planning). Adapters are tried in order,
 * so the registry order is the precedence; detection is expected to be mutually exclusive
 * (each adapter keys on its own authoritative signal), so order is not load-bearing today.
 */
export async function resolveStackAdapter(
  dir: string,
  adapters: readonly IStackAdapter[]
): Promise<IStackAdapter | null> {
  for (const adapter of adapters) {
    if (await adapter.detect(dir)) {
      return adapter;
    }
  }

  return null;
}

/** Session extras the CLI spreads into `Session.create` from the resolved adapter. */
export interface IStackSessionExtras {
  readonly conventions?: IConventionProvider;
  readonly pullConventions?: true;
  readonly guidance?: string;
}

/**
 * Conventions + optional context brief from the adapter that claims `dir`.
 * Empty when no adapter matches. The brief is the specialized-harness map
 * (architecture, generators, wire points, live index) — not a `/map` dump.
 */
export async function adapterSessionExtras(
  dir: string,
  adapters: readonly IStackAdapter[]
): Promise<IStackSessionExtras> {
  const stack = await resolveStackAdapter(dir, adapters);

  if (stack === null) {
    return {};
  }

  const brief =
    stack.contextBrief === undefined ? "" : await stack.contextBrief(dir);

  return {
    ...(stack.conventions === undefined
      ? {}
      : { conventions: stack.conventions, pullConventions: true as const }),
    ...(brief.length > 0 ? { guidance: brief } : {}),
  };
}
