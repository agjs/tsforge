import type { ErrorSet } from "../../validate";
import generatedJson from "./rule-docs.generated.json";
import { activeOverlay } from "../../self-harness/overlay";
import { PACK_RULE_DOCS } from "./pack-rule-docs";

export interface IRuleDoc {
  /** One-line statement of what the rule requires. */
  what: string;
  /** A minimal example that VIOLATES the rule. */
  bad: string;
  /** The corrected version that satisfies it. */
  good: string;
  /** Optional multi-step fix workflow for architecture or meta-rules. */
  procedure?: string;
  /** Filename to lint `bad`/`good` under, for rules whose behaviour depends on
   *  the path (test mirrors, client components, schema files). Consumed only by
   *  `tests/rule-docs-examples.test.ts`, which PROVES every published example
   *  really does trip its rule and that the fix really does satisfy it — a doc
   *  that describes a mechanism the rule does not have sends the model hunting
   *  for something that was never built. Defaults to `src/example.ts`. */
  exampleFile?: string;
  /** Filename for the ✓ example when the fix IS the path (a component that must
   *  move, a test that must mirror its source). Defaults to `exampleFile`. */
  goodFile?: string;
  /** Set when `bad`/`good` are illustrative FILE LAYOUTS rather than compilable
   *  code (a rule whose fix is moving files). Exempts the entry from the
   *  executable-example test — which must stay strict for everything else, since
   *  an unverified example is how a doc came to promise a mechanism that did not
   *  exist. */
  exampleIsProse?: boolean;
  /** Set when adding a `"use client"` / `"use server"` directive IS the whole
   *  fix, as for the `*-require-use-client` rules. Exempts the entry from the
   *  evasion check, which otherwise treats a bolted-on directive as escaping
   *  the rule's scope rather than repairing the code. */
  fixIsDirective?: boolean;
  /** Set when MOVING the code to another file is the documented fix (a secret
   *  that must leave the client bundle, a component that must live elsewhere).
   *  Exempts the entry from the path-escape check, which otherwise treats a
   *  differing `goodFile` as sneaking the snippet out of the rule's scope. */
  fixIsRelocation?: boolean;
  /** Maintainer-only pointer to the rule's implementation or deeper guidance
   *  (tsforge-repo-relative). NEVER emitted into runtime feedback — the model
   *  runs in the user's project where the path dangles. Anything the model
   *  needs at repair time belongs in `procedure`, which is always inlined. */
  reference?: string;
}

/**
 * Auto-fetched docs (eslint/typescript-eslint rules) built offline by
 * `scripts/build-rule-docs.ts` from the rules' own source. Curated entries
 * below take precedence; this fills coverage for everything else.
 */
const GENERATED: Record<string, IRuleDoc> = generatedJson;

/**
 * Curated documentation for the rules our gate actually enforces — each with a
 * before/after, the way a human resolves a lint/type error. Keyed by the exact
 * `rule` the validators emit: TS diagnostic codes (`TS2532`) and eslint rule
 * ids (`@typescript-eslint/...`). Surfacing the rule's own bad→good next to the
 * failure beats making the model re-derive the fix from scratch.
 */
/** Default filename for JSX examples: several rules only fire in a .tsx file. */
const TSX_EXAMPLE = "src/Example.tsx";

export const RULE_DOCS: Record<string, IRuleDoc> = {
  // --- Type-aware: implicit-`any` containment (no `any` token to see) ---
  // (no-unsafe-assignment / -member-access / -return are curated further below)
  "@typescript-eslint/no-unsafe-call": {
    what: "Calling an `any`-typed value. Type the callee so the call is checked.",
    bad: "const fn = lib.run; fn(); // lib is any",
    good: "const fn: () => void = lib.run; fn();",
  },
  "@typescript-eslint/no-unsafe-argument": {
    what: "Passing an `any` into a typed parameter. Validate/narrow before the call.",
    bad: "save(JSON.parse(body));",
    good: "save(UserSchema.parse(JSON.parse(body)));",
  },
  "sonarjs/cognitive-complexity": {
    what: "Function is too tangled (cognitive complexity > 20). Extract named helper functions for the inner branches/loops — don't suppress.",
    bad: "function handle(x) { /* many nested if/for/switch in one body */ }",
    good: "function handle(x) { return isA(x) ? doA(x) : doB(x); } // branches extracted",
  },
  // --- AI-SDK pack ---
  TS2532: {
    what: "Indexed access is `T | undefined` (noUncheckedIndexedAccess). Bind and guard before use; never `!`.",
    bad: "total += arr[i];",
    good: "const x = arr[i]; if (x === undefined) { continue; } total += x;",
  },
  TS18048: {
    what: "Value is possibly `undefined`. Guard it before use.",
    bad: "return obj.maybe.length;",
    good: "const v = obj.maybe; if (v === undefined) { return 0; } return v.length;",
  },
  TS2322: {
    what: "Type is not assignable to the target type — fix the value or the annotation, don't widen to `any`.",
    bad: "const n: number = readLine();",
    good: "const n: number = Number(readLine());",
  },
  TS2307: {
    what: "Module not found — the package isn't installed. Install it first (greenfield dirs have no node_modules); add its `@types/*` if it ships no types.",
    bad: "import { render } from 'react-dom';",
    good: "run: bun add react react-dom @types/react @types/react-dom",
  },
  "@typescript-eslint/no-unsafe-return": {
    what: "Don't return a value typed `any` — narrow it to a real type before returning.",
    bad: "function f() { return JSON.parse(s); }",
    good: "const v: unknown = JSON.parse(s); if (typeof v === 'number') { return v; } return 0;",
  },
  "@typescript-eslint/no-unsafe-assignment": {
    what: "Don't assign an `any` to a typed target — type the source.",
    bad: "const xs = data.map((a, b) => a + b);",
    good: "const xs: number[] = data.map((a: number, b: number) => a + b);",
  },
  "@typescript-eslint/no-unsafe-member-access": {
    what: "Don't access members off an `any`. Narrow to a known type first.",
    bad: "return res.body.id;",
    good: "const body: unknown = res.body; if (isRecord(body)) { return body.id; }",
  },
  "@typescript-eslint/restrict-plus-operands": {
    what: "`+` operands must each be number or string — an `any`/`undefined` is leaking in; type/guard it.",
    bad: "const sum = a + b; // a or b is any | undefined",
    good: "const sum: number = (a ?? 0) + (b ?? 0); // with a, b: number",
  },
  "@typescript-eslint/no-explicit-any": {
    what: "No `any`. Use a real type, or `unknown` + a type guard.",
    bad: "function parse(x: any) {}",
    good: "function parse(x: unknown) { if (typeof x === 'string') { /* ... */ } }",
  },
  "@typescript-eslint/no-non-null-assertion": {
    what: "No `!`. Guard the value instead.",
    bad: "const first = arr[0]!;",
    good: "const first = arr[0]; if (first === undefined) { return; }",
  },
  "@typescript-eslint/consistent-type-assertions": {
    what: "No `as` casts. Narrow with a type guard or use `satisfies`. Branded/nominal ID types (`string & { _brand }`) are off-pattern here — they cannot be constructed without a cast, so don't reach for them; use a plain alias (`type UserId = string`) and validate untrusted values at the boundary.",
    bad: "type UserId = string & { _brand: 'UserId' };\nconst id = raw as unknown as UserId;",
    good: "type UserId = string; // plain alias — no cast to construct\nconst id: UserId = UserSchema.shape.id.parse(raw); // validate at the boundary",
  },
  "@typescript-eslint/strict-boolean-expressions": {
    what: "Conditions must be explicit booleans — no truthy strings/numbers/nullables.",
    bad: "if (name) {}",
    good: "if (name !== undefined && name.length > 0) {}",
  },
  "knip/unused-files": {
    what: "A file exists but no configured entry reaches it, so knip fails it as an unused file. It must be deleted or wired from an entry — you cannot silence it (knip is a file-graph check, not a lint rule).",
    bad: "apps/api/src/api/note/note.service.test.ts  // co-located API test; knip test entries are the mirrored tests/ dir, so this is 'unused' forever",
    good: "apps/api/tests/api/note/note.service.test.ts  // mirrored test path — a configured knip entry",
    procedure:
      "1. If the unused file is a co-located API test under src/, DELETE it and put the test at the mirrored tests/ path (this stack's knip test entries are the mirrored tests dir, NOT co-located src tests). Keep only the mirrored copy. 2. For a production file, import it from an entry (e.g. an index.ts barrel) or delete it. Do this on the FIRST occurrence — an unused-file wall does not resolve by editing other files.",
  },
  "i18n-locale-keys-used": {
    what: "A locale key you added is defined but never referenced in `src`. This means you wrote the translation but not the code that shows it — it does NOT mean the string is unwanted. WIRE IT UP; do NOT delete a translation you just authored to clear this rule (that removes real functionality the feature needs, and you will re-add it later — pure churn).",
    bad: 'await deleteTask(id); // common.json has features.task.deleteError, but no code calls t("features.task.deleteError") → "unused"',
    good: 'try {\n  await deleteTask(id);\n} catch {\n  toast.error(t("features.task.deleteError")); // the key is now referenced\n}',
    procedure:
      "This key is flagged because you added the translation but no `src` code references it YET — the fix is to USE it, not remove it. Wire each unused key to the UI state it names: error keys (createError/updateError/deleteError) → the mutation's onError handler (a toast or inline error rendered via t(key)); confirm keys (confirmDelete) → the destructive action's confirmation dialog/prompt; empty/loading/title keys → the matching render state. Deleting the key is NOT the fix — the harness reverts an edit that drops feature translation keys you added this build (a rename that swaps one key for another is fine; wholesale removal is not). Build the behaviour the string describes.",
  },
  "@typescript-eslint/naming-convention": {
    what: "Interfaces are PascalCase with an `I` prefix.",
    bad: "interface User {}",
    good: "interface IUser {}",
  },
  "@typescript-eslint/no-floating-promises": {
    what: "A promise must be awaited or explicitly voided.",
    bad: "doAsync();",
    good: "await doAsync(); // or: void doAsync();",
  },
  "prefer-const": {
    what: "Use `const` for never-reassigned bindings.",
    bad: "let x = 1;",
    good: "const x = 1;",
  },
  eqeqeq: {
    what: "Use `===`/`!==`.",
    bad: "if (a == b) {}",
    good: "if (a === b) {}",
  },
  "prefer-template": {
    what: "Build strings with template literals, not `+` concatenation.",
    bad: 'const s = "$" + dollars + "." + cents;',
    good: "const s = `$${dollars}.${cents}`;",
  },
  "@typescript-eslint/no-inferrable-types": {
    what: "Drop the type annotation when the initializer makes it obvious — let TS infer.",
    bad: "const negative: boolean = cents < 0;",
    good: "const negative = cents < 0;",
  },

  // React / hooks idioms — same failure-keyed mechanism as the eslint/TS rules,
  // extended to framework rules the React gate enforces. Injected ONLY when the
  // gate names the rule (never a standing wall of framework advice).
  "react-hooks/rules-of-hooks": {
    what: "Hooks run unconditionally at the top of the component — never inside a condition, loop, or after an early return.",
    bad: "if (open) { const [x, setX] = useState(0); }",
    good: "const [x, setX] = useState(0); if (open) { /* use x */ }",
  },
  "react-hooks/exhaustive-deps": {
    what: "A hook's dependency array must list every reactive value it reads; add the missing dep (or memoize/move it).",
    bad: "useEffect(() => { send(query); }, []);",
    good: "useEffect(() => { send(query); }, [query]);",
  },
  "react/jsx-key": {
    what: "Each element in a list needs a stable, unique `key` — an id, not the array index.",
    bad: "items.map((it) => <li>{it.text}</li>)",
    good: "items.map((it) => <li key={it.id}>{it.text}</li>)",
  },
  "react/no-array-index-key": {
    what: "Don't use the array index as `key` — it breaks element identity when the list reorders or filters. Use a stable id.",
    bad: "items.map((it, i) => <li key={i}>{it.text}</li>)",
    good: "items.map((it) => <li key={it.id}>{it.text}</li>)",
  },
  "tsforge/no-inline-jsx-functions": {
    what: "No inline arrow/function expressions in JSX attributes — bind handlers in the hook and pass a reference.",
    bad: "<button onClick={() => doThing(id)} />",
    good: "const onClickRow = useCallback(() => doThing(id), [id]); <button onClick={onClickRow} />",
    procedure:
      "1) Define the handler in the component's hook file, wrapped in `useCallback` with its dependencies. 2) Return it from the hook and destructure it in the component. 3) Pass the reference (`onClick={onClickRow}`). For per-item handlers in a list, extract a row component that receives the item and binds internally.",
    exampleFile: TSX_EXAMPLE,
  },
  "tsforge/index-must-reexport-default": {
    what: "A component folder's `index.ts` may only re-export: the component's default plus optional type re-exports — no logic.",
    bad: "",
    good: "",
    procedure:
      '1) Open the folder\'s `index.ts`. 2) Re-export the component as the DEFAULT: `export { default } from "./Component";` \u2014 `export { default as Component }` creates a named export only and leaves the same gate failing. 3) Keep type re-exports alongside (`export * from "./Component.types"`); move any other code into its own module.',
  },
  "tsforge/max-hooks-per-file": {
    what: "A `*.hooks.ts`/`*.queries.ts`/`*.mutations.ts` module may export at most 4 hooks — split god files by concern before they grow.",
    bad: "",
    good: "",
    procedure:
      "1) Group the file's exported hooks by concern (list vs detail vs mutations). 2) Create one module per group (e.g. `users.list.queries.ts`, `users.mutations.ts`), each ≤ 4 hooks. 3) Move each hook with the imports it needs and update the import sites. 4) Delete the original file once it is empty.",
  },
  "tsforge/component-folder-structure": {
    what: "Each component lives in its own folder with `Component.tsx`, `Component.hooks.ts`, and `index.ts` that re-exports the default.",
    bad: "src/components/Button.tsx  // lone file, hooks inline",
    good: "src/components/Button/Button.tsx + Button.hooks.ts + index.ts",
    procedure:
      "1) Create `Component/` folder. 2) Move hooks to `Component.hooks.ts`. 3) Add `index.ts` with `export { default } from './Component'`. 4) Update imports to the folder path.",
    reference: "packages/core/src/rule-packs/react-component-architecture/",
    exampleIsProse: true,
  },
  "tsforge/no-throw-literal": {
    what: "Throw `Error` instances, not string or number literals.",
    bad: "throw 'Unauthorized';",
    good: "throw new Error('Unauthorized');",
  },
  "tsforge/no-react-fc": {
    what: "Do not use React.FC — type props on the function parameter.",
    bad: "const Button: React.FC<IButtonProps> = ({ onClick }) => <button onClick={onClick} />;",
    good: "function Button({ onClick }: IButtonProps) { return <button onClick={onClick} />; }",
    exampleFile: TSX_EXAMPLE,
  },
  "tsforge/no-component-invocation": {
    what: "Render components as JSX, not function calls.",
    bad: "<div>{Header()}</div>",
    good: "<div><Header /></div>",
    exampleFile: TSX_EXAMPLE,
  },
  "tsforge/no-nested-component": {
    what: "Declare components at module scope, not inside another component.",
    bad: "function App() { function Inner() { return <span />; } return <Inner />; }",
    good: "function Inner() { return <span />; } function App() { return <Inner />; }",
    exampleFile: TSX_EXAMPLE,
  },
  "tsforge/no-inner-html-assignment": {
    what: "Assigning `innerHTML` injects markup as code. Use `textContent` for text, or sanitize with DOMPurify when you genuinely need HTML.",
    bad: "el.innerHTML = userHtml;",
    good: "el.textContent = userText;",
  },
  "tsforge/no-anonymous-useEffect": {
    what: "Pass a named function to useEffect for debuggable stack traces.",
    bad: "useEffect(() => { sync(); }, [id]);",
    good: "useEffect(function syncOnIdChange() { sync(); }, [id]);",
  },
  "tsforge/no-html-img-element": {
    what: "Prefer next/image over raw img elements.",
    bad: "<img src='/hero.jpg' alt='hero' />",
    good: "import Image from 'next/image'; <Image src='/hero.jpg' alt='hero' width={800} height={400} />",
    exampleFile: TSX_EXAMPLE,
  },
  "tsforge/no-sensitive-next-public-env": {
    what: "NEXT_PUBLIC_* vars are exposed in the client bundle — never use for secrets.",
    bad: "process.env.NEXT_PUBLIC_STRIPE_SECRET",
    good: "process.env.STRIPE_SECRET_KEY // server-only, no NEXT_PUBLIC prefix",
  },
  "tsforge/fetch-must-check-ok": {
    what: "`fetch` only rejects on a network failure \u2014 a 4xx/5xx resolves normally, and `.json()` then parses the error body as if it were data. Check the response before reading it.",
    bad: "export async function loadUser(id: string) {\n  const res = await fetch(`/api/users/${id}`);\n\n  return res.json();\n}",
    good: "export async function loadUser(id: string) {\n  const res = await fetch(`/api/users/${id}`);\n\n  if (!res.ok) {\n    throw new Error(`user request failed: ${res.status}`);\n  }\n\n  return res.json();\n}",
    procedure:
      "`fetch` only rejects on network failure \u2014 a 4xx/5xx resolves normally and `.json()` then parses an error body as if it were data. Check `res.ok` (or the status) and throw or return early BEFORE reading the body.",
  },
  "tsforge/json-parse-must-validate": {
    what: "`JSON.parse` returns `any`, so every field downstream is unchecked. Hand its result to a schema and use what the schema returns.",
    bad: "export function loadUser(raw: string) {\n  return JSON.parse(raw);\n}",
    good: 'import { z } from "zod";\n\nconst UserSchema = z.object({ id: z.string(), email: z.string() });\n\nexport function loadUser(raw: string) {\n  return UserSchema.parse(JSON.parse(raw));\n}',
    procedure:
      "Parse THEN validate, and use the validator's return value \u2014 not the raw parse result. `JSON.parse` alone hands back `any`, so the fields are unchecked no matter how they are typed afterwards.",
  },
  "tsforge/no-unsafe-boundary-cast": {
    what: "A cast on parsed boundary input asserts a shape nothing checked, so malformed data flows in silently typed. Validate it and use the validator's return value.",
    bad: "export function loadUser(raw: string) {\n  const user = JSON.parse(raw) as { email: string };\n\n  return user.email;\n}",
    good: 'import { z } from "zod";\n\nconst UserSchema = z.object({ email: z.string() });\n\nexport function loadUser(raw: string) {\n  const user = UserSchema.parse(JSON.parse(raw));\n\n  return user.email;\n}',
    procedure:
      "A cast on boundary input asserts a shape the compiler never checked, so malformed input flows in silently typed. Parse instead: run the value through your schema (`UserSchema.parse(await req.json())`) so failure happens at the boundary with a real error.",
  },
  "tsforge/no-prototype-polluting-merge": {
    what: "Merging request data wholesale lets a caller set `__proto__` and reach every object. Pick the fields you expect explicitly, or parse the body through a schema and merge its result.",
    bad: "Object.assign(config, req.body);",
    good: "const name = UserSchema.parse(req.body).name; config.name = name;",
  },
  "tsforge/server-action-requires-authz-and-validation": {
    what: "Server actions must validate input and call authz before mutations.",
    bad: "",
    good: "",
    procedure:
      "A server action needs BOTH: resolve the caller with your authorization helper and fail closed, then parse the arguments through a schema before touching the database. Typed parameters are not validation \u2014 the client controls what it sends.",
  },
  // BoringStack module-boundaries: a file must hold ONE semantic category. The
  // message lists the mixed categories (type / schema / constant / function / class /
  // react-component / hook) — the fix is always to MOVE the odd one(s) out into the
  // conventionally-named sibling file, never to merge or suppress. (A live build
  // oscillated here once the full message finally surfaced but it couldn't pick the
  // split.)
  "module-boundaries/single-semantic-module": {
    what: "This file mixes semantic categories (the message lists which, e.g. `type` + `schema`). A module must contain exactly ONE concern — split the odd category into its own file and import it back.",
    bad: "// bookmark.schemas.ts\nexport interface IBookmark { url: string } // type\nexport const CreateBookmark = z.object({ url: z.string() }); // schema",
    good: "// bookmark.types.ts (types only)\nexport interface IBookmark { url: string }\n// bookmark.schemas.ts (schemas only — no type declarations)\nexport const CreateBookmark = z.object({ url: z.string() });",
    procedure:
      "1. Read the message: it names the categories present (type/schema/constant/function/class/react-component/hook).\n2. Keep the file's PRIMARY category (the one its name implies: *.schemas.ts→schema, *.types.ts→type, *.constants.ts→constant, *.utils.ts→function, *.service.ts→class+singleton).\n3. MOVE every declaration of the other category into its conventional sibling file (create it if absent): types→*.types.ts, zod/valibot schemas→*.schemas.ts, runtime constants→*.constants.ts, plain functions→*.utils.ts.\n4. Re-import the moved names where they were used. Do NOT merge categories or add an eslint-disable.",
  },
};

/**
 * Strict-TypeScript idiom traps: valid JavaScript the model habitually writes
 * that trips the gate in a way the rule MESSAGE alone doesn't explain — the
 * failure fires at the use-site, not where the bad value was created. Matched
 * against the editable file's SOURCE (not just the errored line), and gated on
 * the error set looking like this trap's failure, so the hint is precise and
 * never fires spuriously on a clean run.
 *
 * Seeded from a real, repeated `money` failure: `new Array(n).fill(x)` is typed
 * `any[]` under strict, so the model fixed it, reintroduced it, and fixed it
 * again across separate turns.
 */
interface IIdiomTrap {
  /** Pattern in the editable source that signals the trap is present. */
  inSource: RegExp;
  /** Tested against each error's `rule + message`; the hint only shows on a match. */
  relevant: RegExp;
  /** The targeted fix, shown when both conditions hold. */
  hint: string;
}

const IDIOM_TRAPS: readonly IIdiomTrap[] = [
  {
    inSource: /new\s+Array\s*\([^)]*\)\s*\.fill\(/,
    relevant: /unsafe|no-explicit-any|\bany\b/i,
    hint: "`new Array(n).fill(x)` is typed `any[]` under strict TypeScript, so every element read off it is `any`. Use `Array.from({ length: n }, () => x)` — it's typed `T[]`.",
  },
  {
    // Elysia's opaque route error: a handler "not assignable to InlineHandler…".
    inSource: /t\.Optional\(\s*t\.String\(\)\s*\)/,
    relevant: /InlineHandler/i,
    hint: "That opaque `InlineHandlerNonMacro` TS2345 on a route is NOT a routing/`.group()` problem — it means your `response:` schema doesn't match what the service returns. The usual cause: a NULLABLE Drizzle column returns `string | null`, but `t.Optional(t.String())` is `string | undefined` (`null` ≠ `undefined`). Change the response field to `t.Optional(t.Union([t.String(), t.Null()]))`, or make the column `.notNull()`. (A `Date` column vs `t.String()` is fine — don't touch that.)",
  },
];

/**
 * Idiom hints for traps whose pattern appears in the given source AND whose
 * signature matches the current errors. `sources` are the editable files'
 * contents; `errors` are the gate failures.
 */
export function idiomHints(
  sources: readonly string[],
  errors: ErrorSet
): string {
  const errText = errors.map((e) => `${e.rule ?? ""} ${e.message}`).join("\n");
  const hints = new Set<string>();

  for (const trap of IDIOM_TRAPS) {
    if (!trap.relevant.test(errText)) {
      continue;
    }

    if (sources.some((s) => trap.inSource.test(s))) {
      hints.add(trap.hint);
    }
  }

  return [...hints].map((h) => `- ${h}`).join("\n");
}

/**
 * Pull rule guidance straight from raw command output (tsc text, `eslint
 * --format json`, plain eslint). This is what lets the docs reach the model
 * when IT runs the gate via the `run` tool — otherwise it only sees raw errors
 * and fixes them blind across many rounds.
 */
export function ruleHelpFromOutput(output: string): string {
  const ids = new Set<string>();

  for (const m of output.matchAll(/TS\d+/g)) {
    ids.add(m[0]);
  }

  for (const m of output.matchAll(/"ruleId"\s*:\s*"([^"]+)"/g)) {
    if (m[1] !== undefined) {
      ids.add(m[1]);
    }
  }

  for (const m of output.matchAll(/@typescript-eslint\/[a-z-]+/g)) {
    ids.add(m[0]);
  }

  // Any `<pack>/<rule>` id in plain eslint text — tsforge's own packs, sonarjs,
  // module-boundaries, and whatever ships next. Matching by SHAPE rather than
  // enumerating packs is what makes a new pack work the day it lands; ruleHelp
  // drops ids it has no doc for, so over-matching costs nothing.
  //
  // Without this the pack catalogue is invisible on the path the MODEL takes
  // when it runs the gate itself via `run`: it sees a bare rule id and goes
  // looking for the answer in the harness source.
  // The boundary guards keep file paths out: in `/app/src/api.ts`, `app/src` is
  // preceded by `/` and `src/api` is followed by `.`, so neither is offered as
  // a rule id. A path fragment that happened to collide with a real doc key
  // would otherwise attach guidance to a line that is not a violation.
  for (const m of output.matchAll(
    /(?<![\w./-])[a-z][a-z0-9-]*\/[a-z][a-z0-9-]+(?![\w./-])/gu
  )) {
    ids.add(m[0]);
  }

  const errors = [...ids].map((rule) => ({ key: rule, rule, message: "" }));

  return ruleHelp(errors);
}

/** Merge the active self-harness overlay's procedure-card edit (if any) for a
 *  rule over its base doc. Returns the base doc unchanged when no edit exists,
 *  and undefined when neither yields a renderable doc (no `what`). */
function applyCardOverlay(
  rule: string,
  doc: IRuleDoc | undefined
): IRuleDoc | undefined {
  const edit = activeOverlay()?.procedureCards[rule];

  if (edit === undefined) {
    return doc;
  }

  const what = edit.what ?? doc?.what;

  if (what === undefined || what.length === 0) {
    return doc;
  }

  const merged: IRuleDoc = {
    what,
    bad: edit.bad ?? doc?.bad ?? "",
    good: edit.good ?? doc?.good ?? "",
  };
  const procedure = edit.procedure ?? doc?.procedure;

  return procedure === undefined ? merged : { ...merged, procedure };
}

/** Keep a multi-line example readable under its ✗/✓ marker: continuation lines
 *  are indented to sit under the first, so the model sees the snippet's own
 *  structure instead of a left-flushed wall.
 *
 *  Surrounding blank lines are dropped first. Several docs are written as
 *  template literals that open with a newline, and indenting that empty first
 *  line puts the snippet a line below its own marker with stray whitespace
 *  between — noise the model has to read past. */
function indentExample(code: string): string {
  return code.trim().split("\n").join("\n    ");
}

/** Format the rule docs for whichever rules appear in the current error set. */
export function ruleHelp(errors: ErrorSet): string {
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const e of errors) {
    if (e.rule === undefined || seen.has(e.rule)) {
      continue;
    }

    // Curated (hand-written, richest) -> verified pack examples -> generated
    // description-only. First hit wins.
    let doc = RULE_DOCS[e.rule] ?? PACK_RULE_DOCS[e.rule] ?? GENERATED[e.rule];

    // A self-harness procedure-card edit merges over the base doc field-wise;
    // with no overlay the base doc passes through untouched. An edit with no
    // base doc still needs a `what` to render a coherent block.
    doc = applyCardOverlay(e.rule, doc);

    if (doc === undefined) {
      continue;
    }

    seen.add(e.rule);

    // Only show the ✗/✓ pair when there is a REAL worked example. Generated-only
    // entries (pack rules without a curated example) carry just `what` — a fake
    // "// Example that violates the rule" placeholder is worse than nothing.
    const hasExample = doc.bad.length > 0 && doc.good.length > 0;

    let block = hasExample
      ? `${e.rule}: ${doc.what}\n  ✗ ${indentExample(doc.bad)}\n  ✓ ${indentExample(doc.good)}`
      : `${e.rule}: ${doc.what}`;

    if (doc.procedure !== undefined && doc.procedure.length > 0) {
      block += `\n  procedure: ${doc.procedure}`;
    }

    // `reference` is deliberately NOT emitted: its paths are tsforge-repo-relative,
    // and the model runs in the USER'S project where they dangle. Everything the
    // model needs must be inline (what/bad/good/procedure).

    blocks.push(block);
  }

  return blocks.join("\n");
}

/**
 * Parse a typescript-eslint rule's source `.mdx` into a doc. The format is
 * regular: a frontmatter `description:` and `<TabItem value="❌ Incorrect">` /
 * `"✅ Correct"` sections each followed by a fenced ```ts block. Used offline by
 * the cache builder. Returns null if the expected sections aren't found.
 */
export function parseRuleMdx(mdx: string): IRuleDoc | null {
  const desc = /^description:\s*['"]([\s\S]+?)['"]\s*$/m.exec(mdx);
  const bad = firstTsBlock(mdx, "❌ Incorrect");
  const good = firstTsBlock(mdx, "✅ Correct");

  if (bad === null || good === null) {
    return null;
  }

  return {
    what: desc?.[1] ?? "",
    bad: cap(bad),
    good: cap(good),
  };
}

function firstTsBlock(mdx: string, marker: string): string | null {
  const at = mdx.indexOf(marker);

  if (at === -1) {
    return null;
  }

  const block = /```ts\n([\s\S]*?)```/.exec(mdx.slice(at));

  return block?.[1]?.trimEnd() ?? null;
}

/** Keep examples prompt-lean — first ~8 lines, capped. */
function cap(code: string): string {
  const lines = code.split("\n").slice(0, 8).join("\n");

  return lines.length > 360 ? `${lines.slice(0, 360)}…` : lines;
}

/**
 * Targeted fix guidance for a quality-REVIEWER's prose critique — the idiomatic
 * issues the GATE can't flag (the model is already green). Keyed by what the
 * judge actually complains about on Q4 runs: over-annotation, gratuitous
 * undefined guards, locale-less toLocaleString, `+` concatenation, terse names.
 * Turns a vague "make it more idiomatic" into a concrete bad→good, the same way
 * ruleHelp does for lint failures — but on the quality channel, not the gate.
 */
interface IQualityHint {
  /** Tested against the judge's notes prose. */
  match: RegExp;
  advice: string;
}

const QUALITY_HINTS: readonly IQualityHint[] = [
  {
    match: /verbose|explicit|redundant|annotation/i,
    advice:
      "Drop redundant type annotations — let TS infer obvious locals/returns (`const n = total;`, not `const n: number = total;`). Annotate parameters and unclear inference only.",
  },
  {
    match: /unnecessary|undefined check|null check/i,
    advice:
      "Remove `=== undefined`/null guards the compiler doesn't require (a value already narrowed, or a non-indexed access). Guard ONLY where `noUncheckedIndexedAccess` actually flags it.",
  },
  {
    match: /locale|toLocaleString/i,
    advice:
      'Pass an explicit locale: `n.toLocaleString("en-US")` — bare `toLocaleString()` is environment-dependent.',
  },
  {
    match: /concatenat|string \+| \+ |\bconcat\b/i,
    advice:
      "Prefer template literals over `+` string concatenation: `` `${dollars}.${cents}` ``.",
  },
  {
    match: /terse|short name|parameter name|\bnaming\b/i,
    advice: "Name parameters descriptively (`acc`, `ratio` — not `a`, `r`).",
  },
];

/** Concrete fix guidance for a quality reviewer's critique, or "" if none match. */
export function qualityHints(notes: string): string {
  return QUALITY_HINTS.filter((h) => h.match.test(notes))
    .map((h) => `- ${h.advice}`)
    .join("\n");
}
