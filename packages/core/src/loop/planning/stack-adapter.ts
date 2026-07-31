import type { IPlanConstraints } from "./plan-types";

/**
 * A STACK adapter as the generic planner/CLI sees it. The core greenfield flow knows
 * only this interface — it never names a concrete stack. An adapter answers two
 * questions for a project directory:
 *   - `detect(dir)`: is this project mine? (e.g. a scaffold receipt)
 *   - `planConstraints(onStripped)`: the stack-specific planner constraints (guidance +
 *     reserved-entity stripping), fail-closed via `IPlanConstraints`.
 * Concrete adapters (BoringStack today, Phaser next) live under their own adapter
 * directory and are registered by the composition root (the CLI), never imported by
 * core planning logic.
 */
export interface IStackAdapter {
  /** Stable id, e.g. "boringstack" — used in surfaced messages, not for control flow. */
  readonly id: string;
  /** Whether this adapter owns the project at `dir` (authoritative, no false positives). */
  detect(dir: string): Promise<boolean>;
  /** The stack's planner constraints; `onStripped` surfaces every dropped entity id. */
  planConstraints(
    onStripped: (droppedEntityIds: readonly string[]) => void
  ): IPlanConstraints;
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
