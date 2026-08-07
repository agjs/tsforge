/**
 * Mermaid node-id safety.
 *
 * Mermaid parses in the BROWSER, so a syntax error renders as a blank gap on the page
 * while `astro build` still reports success — the failure is invisible to CI. A node id
 * that collides with a grammar keyword is the easiest way to hit that: `call --> resp`
 * fails with "got 'CALLBACKNAME'" because `call` belongs to the `click ... call fn()`
 * syntax. These helpers make the collision impossible in generated output and detectable
 * in hand-written pages.
 */

/**
 * Words the flowchart grammar claims. Using one as a bare node id is a parse error.
 *
 * Not exhaustive for every mermaid diagram type — this is the flowchart set, which is
 * what this repo draws. Add to it rather than working around it.
 */
export const MERMAID_RESERVED: ReadonlySet<string> = new Set([
  "graph",
  "flowchart",
  "subgraph",
  "end",
  "call",
  "click",
  "class",
  "classDef",
  "style",
  "linkStyle",
  "default",
  "href",
  "callback",
  "direction",
]);

/** Prefix that keeps a generated id out of the grammar's namespace entirely. */
/**
 * Node ids in a mermaid source block that collide with a reserved word.
 *
 * Reads the declaration form `id["label"]` / `id{"label"}` and the edge form
 * `a --> b`, which together cover how this repo writes flowcharts. Returns the offenders
 * so a test can name them; an empty array means nothing reserved was used as an id.
 */
export function reservedNodeIds(diagram: string): string[] {
  const found = new Set<string>();

  for (const line of diagram.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("%%")) {
      continue;
    }

    for (const pattern of ID_PATTERNS) {
      collectReserved(trimmed, pattern, found);
    }
  }

  return [...found].sort();
}

/**
 * Where a node id can appear: a declaration (`id["label"]`, `id{"label"}`), the source
 * of an edge, and the target of an edge (including after an `|label|` edge caption).
 */
const ID_PATTERNS: readonly RegExp[] = [
  /([A-Za-z_][A-Za-z0-9_]*)\s*[[{(]/g,
  /(?:^|\|\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(?:-{2,3}>|-{2,3}|={2,3}>)/g,
  /(?:-{2,3}>|={2,3}>|\|)\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/g,
];

/** Add any reserved word captured by `pattern` to `into`. */
function collectReserved(
  line: string,
  pattern: RegExp,
  into: Set<string>
): void {
  for (const match of line.matchAll(pattern)) {
    const id = match[1];

    if (id !== undefined && MERMAID_RESERVED.has(id)) {
      into.add(id);
    }
  }
}

/** Every ```mermaid fenced block in a Markdown/MDX document. */
export function mermaidBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .filter((block): block is string => block !== undefined);
}
