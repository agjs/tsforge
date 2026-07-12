/**
 * The boringstack CONVENTION library — the "how to write it right" knowledge the
 * model needs AT write-time, distilled from boringstack's `docs/agents/*` and kept
 * in lockstep with what the gate enforces. Two delivery paths use it:
 *   • PUSH (primary) — the harness injects the relevant guide the moment the model
 *     does the matching thing (e.g. creates its first component), so it writes
 *     compliant code the FIRST time instead of writing wrong then refactoring.
 *   • PULL (secondary) — the `pull_conventions` tool lets the model fetch a guide
 *     on demand for the long tail the harness can't pre-anticipate.
 * Concise on purpose: a local model absorbs a focused 8-line guide, not a 368-line
 * wall. Each guide maps 1:1 to the rules that reject its violation.
 */

/** The convention topics the model can be handed or pull. Single source of truth:
 *  the const tuple drives both the type and the runtime list (no `as` cast). */
const TOPICS = [
  "component-anatomy",
  "file-layout",
  "jsx",
  "state",
  "no-casts",
  "routing",
  "forms",
] as const;

export type ConventionTopic = (typeof TOPICS)[number];

/** Membership set for the topic guard — a `Set<string>` so the check is a clean
 *  `.has()` (no `as` cast, no `.some()` that unicorn flags). */
const TOPIC_SET = new Set<string>(TOPICS);

/** topic → the enforced-rule(s) it prevents, for cross-referencing gate errors. */
export const TOPIC_RULES: Readonly<Record<ConventionTopic, readonly string[]>> =
  {
    "component-anatomy": [
      "component-folder-structure",
      "one-component-per-file",
      "index-must-reexport-default",
    ],
    "file-layout": ["component-file-purity"],
    jsx: ["no-jsx-computation", "no-inline-jsx-functions"],
    state: ["no-state-in-component-body", "max-hooks-per-file"],
    "no-casts": ["no-restricted-syntax", "no-non-null-assertion"],
    routing: ["component-folder-structure"],
    forms: [],
  };

const GUIDES: Readonly<Record<ConventionTopic, string>> = {
  "component-anatomy":
    "COMPONENT ANATOMY (boringstack). A component file `.tsx` renders props — it " +
    "does NOT own state. Put each component in `src/views/<Feature>/`: the view root " +
    "is `index.tsx`; extra components go in `components/<Name>.tsx`, ONE component per " +
    "file. State/effects/memo live in `<feature>.hooks.ts`, never in the component " +
    "body — the component imports the hook and consumes its return value. Types → " +
    "`<feature>.types.ts`, constants → `<feature>.constants.ts`. NEVER place a " +
    "component under `src/features/` (that's the data layer) — views live under " +
    "`src/views/`. shadcn primitives in `src/components/ui/` are exempt.",
  "file-layout":
    "FILE PURITY (boringstack). A component `.tsx` holds ONLY imports + the component " +
    "— nothing else atop it. Move each out and import it back: a type → " +
    "`<feature>.types.ts`; a constant / label-map / column-spec → " +
    "`<feature>.constants.ts` (`as const`); a pure helper (formatX, timeAgo) → " +
    "`src/lib/<name>.ts`. Inline types/constants/helpers are a gate error " +
    "(component-file-purity).",
  jsx:
    "JSX (boringstack). No COMPUTATION inside JSX — the markup only READS " +
    "already-computed values. A derived value → a `useMemo` in `<feature>.hooks.ts`; " +
    "a pure transform → a function in `src/lib`. A simple ternary is fine; a " +
    "`.map()`/`.filter()`/arithmetic/`Object.entries()` in the markup is not (extract " +
    "it). Every `<button>` needs an explicit `type`.",
  state:
    "STATE (boringstack). ALL `useState`/`useReducer`/`useEffect`/`useMemo`/" +
    "`useCallback` live in `<feature>.hooks.ts`, never in a component body. Server " +
    "data → a hook using react-query/fetch that narrows the response. A hooks file " +
    "exporting too many hooks splits into focused modules (e.g. `*.queries.ts` + " +
    "`*.mutations.ts`).",
  "no-casts":
    "NO CASTS (boringstack). Never write `x as T` or `x!`. To narrow a value (e.g. a " +
    "`<select>` string to a union), use a TYPE GUARD: keep the allowed values in a " +
    "const map (`as const` IS allowed) and guard with `in` — " +
    "`const S = {open:1,closed:1} as const; type St = keyof typeof S; " +
    "function isSt(v:string): v is St { return v in S; }` then `if (isSt(v)) {…}`. " +
    "For a possibly-null DOM/query result, guard with `if (x === null) return` or " +
    "`instanceof`, never `!`.",
  routing:
    "ROUTING (boringstack). A route file is THIN: it imports its view and renders it " +
    "(e.g. `component: Dashboard` from `@/views/Dashboard`) — NO UI or logic of its " +
    "own. Create ALL route files at once with `scaffold_routes` (list, detail with " +
    "`$param` like `/accounts/$accountId`, create/edit), THEN fill each view. Never " +
    "hand-write a route file or put a component's body in one.",
  forms:
    "FORMS (boringstack). Use react-hook-form's `useForm` inside `<Component>.hooks.ts` " +
    "(not the component body). Map server/validation errors back onto the form fields; " +
    "keep the component rendering the field state the hook returns.",
};

/** The guide for a topic (the exact string pushed or pulled). */
export function conventionGuide(topic: ConventionTopic): string {
  return GUIDES[topic];
}

/** Every topic name — for the pull tool's enum + listings. */
export function conventionTopics(): ConventionTopic[] {
  return [...TOPICS];
}

/** Narrow an arbitrary string to a ConventionTopic (for the pull tool's arg) —
 *  membership test, no `as` cast. */
export function isConventionTopic(s: string): s is ConventionTopic {
  return TOPIC_SET.has(s);
}

/** The topic whose enforced rules include `rule` (bare or plugin-prefixed), or null.
 *  Lets a gate error cross-reference the guide that prevents it. */
export function topicForRule(rule: string): ConventionTopic | null {
  const bare = rule.split("/").pop() ?? rule;

  for (const topic of conventionTopics()) {
    if (TOPIC_RULES[topic].includes(bare)) {
      return topic;
    }
  }

  return null;
}

/**
 * PUSH helper: the convention guides for the gate errors whose rule maps to a topic
 * NOT already shown this run (`seen` is mutated to dedupe). This is how the loop
 * hands the model the boringstack how-to the FIRST time it trips a rule — right
 * beside the error, not after the steering ladder escalates. One guide per topic
 * per run: enough to teach, not a wall.
 */
export function unseenGuidesForErrors(
  errors: readonly { readonly rule?: string }[],
  seen: Set<string>
): string[] {
  const out: string[] = [];

  for (const e of errors) {
    if (e.rule === undefined) {
      continue;
    }

    const topic = topicForRule(e.rule);

    if (topic === null || seen.has(topic)) {
      continue;
    }

    seen.add(topic);
    out.push(conventionGuide(topic));
  }

  return out;
}
