import type { ICycle, IEdge } from "./architecture.types";

/** Fan-in per subsystem: how many other subsystems import it. */
export function fanIn(edges: readonly IEdge[]): ReadonlyMap<string, number> {
  return tally(edges.map((e) => e.to));
}

/** Fan-out per subsystem: how many other subsystems it imports. */
export function fanOut(edges: readonly IEdge[]): ReadonlyMap<string, number> {
  return tally(edges.map((e) => e.from));
}

function tally(ids: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return counts;
}

/**
 * Every mutual (2-node) dependency cycle, each reported once with both witnesses.
 *
 * Deliberately limited to mutual pairs. Longer cycles exist in any graph this dense
 * and enumerating them buries the actionable ones — a mutual pair names two files
 * that import each other, which is a coupling someone can actually go and break.
 * The generated page says this, so a short list is not read as a clean bill.
 */
export function findMutualCycles(edges: readonly IEdge[]): ICycle[] {
  const byPair = new Map<string, IEdge>();

  for (const edge of edges) {
    byPair.set(`${edge.from} ${edge.to}`, edge);
  }

  const cycles: ICycle[] = [];

  for (const edge of edges) {
    if (edge.from >= edge.to) {
      continue;
    }

    const back = byPair.get(`${edge.to} ${edge.from}`);

    if (back === undefined) {
      continue;
    }

    cycles.push({ a: edge.from, b: edge.to, aToB: edge, bToA: back });
  }

  return cycles.sort((x, y) => {
    const byFirst = x.a.localeCompare(y.a);

    return byFirst !== 0 ? byFirst : x.b.localeCompare(y.b);
  });
}
