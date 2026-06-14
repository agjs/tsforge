import { dirname, join, normalize } from "node:path";
import type {
  IMetaRule,
  IMetaRuleContext,
  IMetaRuleViolation,
} from "../../meta-rules.types";

/**
 * Circular imports (A → B → A) are a cross-file smell that per-file ESLint cannot
 * see: they cause partially-initialized modules (TDZ/`undefined` at import time),
 * defeat tree-shaking, and make refactors brittle. We build the module graph from
 * the project's own relative imports and report each cyclic group once.
 *
 * Only RELATIVE imports (`./`, `../`) are followed — alias/bare specifiers need a
 * resolver and would risk false positives. That keeps this high-precision: every
 * reported cycle is real, in-project, and the model's to break.
 */
const IMPORT_FROM = /(?:import|export)[^'"]*?from\s*['"](?<spec>[^'"]+)['"]/gu;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"](?<spec>[^'"]+)['"]\s*\)/gu;

/** Relative import specifiers (`./x`, `../y`) found in one file's text. */
function relativeSpecifiers(text: string): string[] {
  const out: string[] = [];

  for (const re of [IMPORT_FROM, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;

    for (const m of text.matchAll(re)) {
      const spec = m.groups?.spec;

      if (spec?.startsWith(".") === true) {
        out.push(spec);
      }
    }
  }

  return out;
}

/** Resolve a relative specifier to a known source file, or null. */
function resolveToSourceFile(
  fromFile: string,
  spec: string,
  fileSet: ReadonlySet<string>
): string | null {
  const base = normalize(join(dirname(fromFile), spec))
    .split("\\")
    .join("/");
  const candidates =
    base.endsWith(".ts") || base.endsWith(".tsx")
      ? [base]
      : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];

  for (const candidate of candidates) {
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Adjacency list of in-project module edges. */
function buildGraph(ctx: IMetaRuleContext): Map<string, string[]> {
  const fileSet = new Set(ctx.sourceFiles);
  const graph = new Map<string, string[]>();

  for (const file of ctx.sourceFiles) {
    const text = ctx.readFile(file);
    const edges: string[] = [];

    if (text !== null) {
      for (const spec of relativeSpecifiers(text)) {
        const target = resolveToSourceFile(file, spec, fileSet);

        if (target !== null && target !== file) {
          edges.push(target);
        }
      }
    }

    graph.set(file, edges);
  }

  return graph;
}

interface ITarjanState {
  readonly index: Map<string, number>;
  readonly low: Map<string, number>;
  readonly onStack: Set<string>;
  readonly stack: string[];
  readonly components: string[][];
  counter: number;
}

/** Tarjan's strongly-connected-components — each SCC with >1 node (or a self-loop)
 *  is an import cycle. Iterative-free recursion is fine for project-sized graphs. */
function strongConnect(
  node: string,
  graph: Map<string, string[]>,
  state: ITarjanState
): void {
  state.index.set(node, state.counter);
  state.low.set(node, state.counter);
  state.counter += 1;
  state.stack.push(node);
  state.onStack.add(node);

  for (const next of graph.get(node) ?? []) {
    if (!state.index.has(next)) {
      strongConnect(next, graph, state);
      state.low.set(
        node,
        Math.min(state.low.get(node) ?? 0, state.low.get(next) ?? 0)
      );
    } else if (state.onStack.has(next)) {
      state.low.set(
        node,
        Math.min(state.low.get(node) ?? 0, state.index.get(next) ?? 0)
      );
    }
  }

  if (state.low.get(node) === state.index.get(node)) {
    const component: string[] = [];

    for (;;) {
      const popped = state.stack.pop();

      if (popped === undefined) {
        break;
      }

      state.onStack.delete(popped);
      component.push(popped);

      if (popped === node) {
        break;
      }
    }

    state.components.push(component);
  }
}

/** All cyclic groups: SCCs of size > 1, plus single nodes that import themselves. */
function findCycles(graph: Map<string, string[]>): string[][] {
  const state: ITarjanState = {
    index: new Map(),
    low: new Map(),
    onStack: new Set(),
    stack: [],
    components: [],
    counter: 0,
  };

  for (const node of graph.keys()) {
    if (!state.index.has(node)) {
      strongConnect(node, graph, state);
    }
  }

  return state.components.filter((c) => {
    if (c.length > 1) {
      return true;
    }

    const only = c[0];

    return only !== undefined && (graph.get(only) ?? []).includes(only);
  });
}

export const noCircularImportsRule: IMetaRule = {
  id: "no-circular-imports",
  category: "stack-layout",
  description:
    "Project modules must not form import cycles (A → B → A) — they cause partial-initialization bugs and defeat tree-shaking.",
  severity: "error",
  run(ctx) {
    const cycles = findCycles(buildGraph(ctx));

    return cycles.map((cycle): IMetaRuleViolation => {
      const ordered = [...cycle].sort();

      return {
        file: ordered[0] ?? "src",
        ruleId: "no-circular-imports",
        severity: "error",
        message: `Import cycle between ${ordered.length} modules: ${ordered.join(" ↔ ")}. Break it by extracting the shared piece into a third module both can import.`,
      };
    });
  },
};
