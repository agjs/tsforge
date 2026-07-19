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
  "data-fetching",
  "lint-gotchas",
  "testing",
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
    // `no-unnecessary-condition` on an apiClient call is the tell that the model
    // guarded `response.error` — this stack throws on errors, so that guard is dead.
    // Mapping it here pushes the data-fetching guide on the FIRST such red.
    "data-fetching": ["no-unnecessary-condition"],
    // The strict-lint rules a fresh feature trips most (measured on a live build): floating/
    // un-awaited promises, void-returning expressions used as values, errors stringified into
    // logs, and repeated string literals. None are structural — they're write-time habits the
    // model gets wrong then grinds down one gate at a time.
    "lint-gotchas": [
      "await-thenable",
      "no-floating-promises",
      "no-confusing-void-expression",
      "no-error-stringify",
      "no-duplicate-string",
    ],
    // Tests were 61% of the edits on a live CRUD build (measured) — the model doesn't
    // know the stack's test idioms so it flails: guesses .test.ts vs .test.tsx (and makes
    // BOTH), reinvents the api-client mock (getting `any`-typed `data`), uses the wrong
    // vi mock method. These rules fire on those mistakes; the guide teaches the idiom.
    testing: [
      "test-sibling-required",
      "test-file-mirrors-source",
      "no-focused-tests",
      "no-conditional-expect",
      "no-real-network-in-unit-tests",
      "fake-timers-must-be-restored",
    ],
  };

const GUIDES: Readonly<Record<ConventionTopic, string>> = {
  "component-anatomy":
    "COMPONENT ANATOMY (boringstack). A feature lives in `src/features/<feature>/`. " +
    "Components go under `src/features/<feature>/components/<Name>/`: `<Name>.tsx` " +
    "renders props (it does NOT own state), and `index.ts` re-exports the default — " +
    "ONE component per file. State/effects/memo live in `<Name>.hooks.ts`, never in " +
    "the component body — the component imports the hook and consumes its return " +
    "value. Feature-level files sit at `src/features/<feature>/`: `<Feature>.types.ts`, " +
    "`<Feature>.constants.ts`, `<Feature>.queries.ts`, `<Feature>.mutations.ts`. shadcn " +
    "primitives in `src/components/ui/` are exempt.",
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
    "data → a hook using react-query over the generated api-client (NEVER raw `fetch` — " +
    "see data-fetching) that narrows the response. A hooks file " +
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
    "ROUTING (boringstack). A route file is THIN: it imports its feature page and " +
    "renders it — NO UI or logic of its own. Register the feature's page in the SPA " +
    "router (`src/app/router/routes.tsx`) pointing at `@/features/<feature>` — never " +
    "hand-write a component's body in a route file.",
  forms:
    "FORMS (boringstack). Use react-hook-form's `useForm` inside `<Component>.hooks.ts` " +
    "(not the component body). Map server/validation errors back onto the form fields; " +
    "keep the component rendering the field state the hook returns.",
  "data-fetching":
    "DATA-FETCHING (boringstack). ALL HTTP goes through the generated client " +
    "`@/lib/api/client` — never `fetch`/`axios` (lint-banned). Call it as " +
    '`const { data } = await apiClient.GET("/path")` (or `.POST`/`.PATCH`/`.DELETE` ' +
    "with `{ body }`); `data` is typed from the OpenAPI spec. Errors THROW " +
    "automatically via the client's `throwOnError` middleware (TanStack Query catches " +
    "them) — so NEVER check `response.error`: it is typed `undefined`, so the guard is " +
    "a dead `no-unnecessary-condition` gate error. Just read `data`. Put queries in " +
    "`<Feature>.queries.ts` and mutations in `<Feature>.mutations.ts`. If a path isn't " +
    "in the spec yet, add the API route first, then `bun run generate:api`.",
  "lint-gotchas":
    "STRICT-LINT GOTCHAS (boringstack). The gate is eslint with EVERY rule an error; a fresh " +
    "feature trips these most, so write them right up front:\n" +
    "• AWAIT the promises you use — an un-awaited async call is a no-floating-promises error; " +
    "write `await doX()` (or `void doX()` to deliberately fire-and-forget).\n" +
    "• …but do NOT await non-promises — `await` on a plain value or a sync function's result is " +
    "an await-thenable error; drop the `await`.\n" +
    "• NO value out of a void expression — never `return foo.forEach(...)` or " +
    "`const x = setState(v)`; call the void thing, then return/act separately. For handlers use " +
    "a BLOCK body: `onClick={() => { setOpen(true); }}`, not `() => setOpen(true)`.\n" +
    "• NEVER stringify an error into a log — pass the error object: " +
    '`log.error({ err }, "failed")`, never `` log.error(`${err}`) `` or `String(err)`.\n' +
    "• HOIST heavily-repeated string literals — the same literal 5+ times is a no-duplicate-string " +
    "error; pull it into a `const` (or `<Feature>.constants.ts`) and reference that.",
  testing:
    "TESTING (boringstack). Every logic file needs a co-located test (test-sibling-required), " +
    "and tests are where builds waste the MOST turns — because the model guesses the idioms. " +
    "Write them right the first time:\n" +
    "• EXTENSION — pick ONE, never both: `.test.tsx` ONLY if the test renders JSX (`renderHook` " +
    "with a wrapper, `render`, any `<X/>`); `.test.ts` for pure logic (schemas, utils, services, " +
    "API route tests). The sibling check accepts EITHER, so if you create both, the unused twin " +
    "becomes a knip `unused file` error. A `<X>` inside a `.test.ts` parses as a generic and fails " +
    "with `'>' expected` — that means the file must be `.test.tsx`.\n" +
    "• UI query/mutation/hook tests (`.test.tsx`) — mock the api-client HOISTED at the top, exactly " +
    "this shape:\n" +
    "    const apiMock = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() }));\n" +
    '    vi.mock("@/lib/api/client", () => ({ apiClient: apiMock }));\n' +
    "  Return a CONCRETE typed object from the mock — `apiMock.POST.mockResolvedValueOnce({ data: { " +
    "...the real response shape... } })`. A concrete literal keeps `data` typed; a bare `vi.fn()` " +
    "return is `any`, which then trips no-unsafe/no-unnecessary-condition in the code under test " +
    "(do NOT try to fix that by casting or changing production code). Use `mockResolvedValueOnce` " +
    "per call; use `mockResolvedValue` only for a call that retries (e.g. a GET-me loop). RESET the " +
    "mocks between tests — `beforeEach(() => { apiMock.GET.mockReset(); apiMock.POST.mockReset(); … })` " +
    "(or `vi.clearAllMocks()`) — or a leftover `mockResolvedValue` leaks into the next test (it passes " +
    "alone but fails in the suite). Wrap the " +
    "hook in a `QueryClient` with `retry:false` via `renderHook(() => useX(), { wrapper })` and " +
    "assert with `await waitFor(() => …)`. Imports: `vitest` (`describe, it, expect, vi, beforeEach`) " +
    "+ `@testing-library/react` (`renderHook, waitFor, act`) + `@tanstack/react-query`.\n" +
    "• API route tests (`apps/api/tests/**/*.routes.test.ts`, pure `.ts`) — handle the app in-process, " +
    "never a real network (no-real-network-in-unit-tests):\n" +
    '    const app = createApp(); // from "../../../src/config/app"\n' +
    '    const res = await app.handle(new Request("http://localhost/api/v1/<path>", { method, headers, body }));\n' +
    "    expect(res.status).toBe(200);\n" +
    "  Read the body as `unknown` then TYPE-GUARD it (`const isX = (v: unknown): v is {…} => …; if " +
    "(!isX(body)) throw new Error(…)`) — never `as`. For an authed route, define a local `loginCookie` " +
    "helper (copy it verbatim from an existing `*.routes.test.ts`) and pass the returned cookie in headers.\n" +
    "• RULES the gate enforces: no `.only`/`.skip` (no-focused-tests); never put `expect` inside an " +
    "`if`/`try`/`catch` (no-conditional-expect); if you use fake timers, restore them in `afterEach` " +
    "(fake-timers-must-be-restored); the test path/name mirrors its source (test-file-mirrors-source).\n" +
    "• After you write a test the harness AUTO-FORMATS it (imports reordered, quotes/commas normalized), " +
    "so your next `edit` oldString won't match — RE-READ the file and copy oldString from its current " +
    "content; do NOT recreate the whole file.",
};

/** The guide for a topic (the exact string pushed or pulled). */
export function conventionGuide(topic: ConventionTopic): string {
  return GUIDES[topic];
}

/** Every topic name — for the pull tool's enum + listings. */
export function conventionTopics(): ConventionTopic[] {
  return [...TOPICS];
}

/** The full PUSH body of every stack convention GUIDE (not just a topic index), joined for the
 *  build system prompt (WS-A1). Front-loading the actual compliant patterns — the exact shape
 *  for components, state, JSX, casts, data-fetching, etc. — lets the model write it right on the
 *  FIRST draft instead of guessing from memory and burning turns at the gate. The reactive PUSH
 *  (`unseenGuidesForErrors`) and `pull_conventions` remain fallbacks for reinforcement and the
 *  long tail, not the primary teaching. */
export function buildConventionGuides(): string {
  return [
    "HOW THIS STACK WRITES CODE — read this BEFORE you write, not after the gate rejects you. These are the exact compliant patterns the gate enforces; write your FIRST draft this way instead of guessing from memory and burning turns repairing. (`pull_conventions` re-fetches any of these on demand.)",
    "",
    ...conventionTopics().map((t) => conventionGuide(t)),
  ].join("\n\n");
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
