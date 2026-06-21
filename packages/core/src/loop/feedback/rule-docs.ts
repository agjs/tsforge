import type { ErrorSet } from "../../validate";
import generatedJson from "./rule-docs.generated.json";

export interface IRuleDoc {
  /** One-line statement of what the rule requires. */
  what: string;
  /** A minimal example that VIOLATES the rule. */
  bad: string;
  /** The corrected version that satisfies it. */
  good: string;
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
const RULE_DOCS: Record<string, IRuleDoc> = {
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
  "tsforge/no-api-key-in-client": {
    what: "An AI provider client constructed in a `'use client'` file ships the API key to the browser. Call the model from a server route/action.",
    bad: "'use client';\nconst client = new OpenAI({ apiKey: process.env.KEY });",
    good: "// server action / route handler:\nconst client = new OpenAI({ apiKey: process.env.KEY });",
  },
  "tsforge/require-completion-token-limit": {
    what: "AI completion calls must bound output tokens to cap cost/latency.",
    bad: "await generateText({ model, prompt });",
    good: "await generateText({ model, prompt, maxTokens: 512 });",
  },
  "tsforge/no-user-input-in-system-prompt": {
    what: "Don't splice request/user data into the system prompt (injection). Keep the system prompt constant; pass user input as a user message.",
    bad: "generateText({ system: `You are ${role}`, prompt });",
    good: "generateText({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userInput }] });",
  },
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
    what: "No `as` casts. Use a type guard or `satisfies`.",
    bad: "const u = json as IUser;",
    good: "if (isUser(json)) { const u = json; /* narrowed */ }",
  },
  "@typescript-eslint/strict-boolean-expressions": {
    what: "Conditions must be explicit booleans — no truthy strings/numbers/nullables.",
    bad: "if (name) {}",
    good: "if (name !== undefined && name.length > 0) {}",
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
  "tsforge/no-jsx-computation": {
    what: "No `.map()`/`.filter()`/arithmetic/chained logic inside JSX `{…}` — extract to a hook or pre-prep variable first.",
    bad: "<ul>{items.filter((i) => i.visible).map((i) => <li key={i.id}>{i.label}</li>)}</ul>",
    good: "const rows = useMemo(() => items.filter(...).map(...), [items]); return <ul>{rows}</ul>;",
  },
  "tsforge/no-loading-text-use-skeleton": {
    what: "Loading states render a <Skeleton/> shaped like the content — never 'Loading…' text or a spinner. Add `skeleton` via scaffold_ui.",
    bad: "if (isLoading) { return <p>Loading…</p>; }",
    good: 'if (isLoading) { return <Skeleton className="h-8 w-full" />; }',
  },
  "tsforge/no-state-in-component-body": {
    what: "State hooks (`useState`, `useEffect`, `useMemo`, …) belong in `Component.hooks.ts`, not in the `.tsx` component body.",
    bad: "export function Button() { const [open, setOpen] = useState(false); return <button />; }",
    good: "export function useButton() { const [open, setOpen] = useState(false); return { open }; }",
  },
  "tsforge/no-inline-jsx-functions": {
    what: "No inline arrow/function expressions in JSX attributes — bind handlers in the hook and pass a reference.",
    bad: "<button onClick={() => doThing(id)} />",
    good: "const onClickRow = useCallback(() => doThing(id), [id]); <button onClick={onClickRow} />",
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
  },
  "tsforge/no-component-invocation": {
    what: "Render components as JSX, not function calls.",
    bad: "<div>{Header()}</div>",
    good: "<div><Header /></div>",
  },
  "tsforge/no-nested-component": {
    what: "Declare components at module scope, not inside another component.",
    bad: "function App() { function Inner() { return <span />; } return <Inner />; }",
    good: "function Inner() { return <span />; } function App() { return <Inner />; }",
  },
  "tsforge/dangerous-html-requires-sanitize": {
    what: "Sanitize HTML before dangerouslySetInnerHTML — import DOMPurify.",
    bad: "<div dangerouslySetInnerHTML={{ __html: rawHtml }} />",
    good: "import DOMPurify from 'isomorphic-dompurify'; <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(rawHtml) }} />",
  },
  "tsforge/no-child-process-exec": {
    what: "Do not use child_process.exec/execSync — shell execution enables command injection.",
    bad: "import { exec } from 'child_process'; exec(`rm -rf ${dir}`);",
    good: "import { execFile } from 'child_process'; execFile('rm', ['-rf', dir], callback);",
  },
  "tsforge/no-spawn-with-shell": {
    what: "Do not pass `{ shell: true }` to spawn/spawnSync.",
    bad: "spawn('sh', ['-c', cmd], { shell: true });",
    good: "spawn('node', ['script.js', arg]);",
  },
  "tsforge/no-dynamic-regexp": {
    what: "Do not build RegExp from runtime input — ReDoS risk.",
    bad: "const re = new RegExp(userPattern);",
    good: "const re = /^fixed-pattern$/;",
  },
  "tsforge/no-inner-html-assignment": {
    what: "Do not assign to innerHTML — XSS risk in vanilla DOM code.",
    bad: "el.innerHTML = userHtml;",
    good: "el.textContent = userText;",
  },
  "tsforge/catch-must-handle": {
    what: "Catch blocks must log, rethrow, or return a typed error — not silently mask failure.",
    bad: "catch (e) { return null; }",
    good: "catch (e) { logger.error(e); throw e; }",
  },
  "tsforge/no-react-in-services": {
    what: "Service/data modules must not import React — keep business logic decoupled from UI.",
    bad: "import { useMemo } from 'react'; // in src/services/users.ts",
    good: "Move React hooks to components; keep services as plain TypeScript.",
  },
  "tsforge/no-anonymous-useEffect": {
    what: "Pass a named function to useEffect for debuggable stack traces.",
    bad: "useEffect(() => { sync(); }, [id]);",
    good: "useEffect(function syncOnIdChange() { sync(); }, [id]);",
  },
  "tsforge/no-derived-state-in-effect": {
    what: "Do not set local state inside useEffect when the value can be derived during render.",
    bad: "useEffect(() => { setFullName(first + ' ' + last); }, [first, last]);",
    good: "const fullName = `${first} ${last}`;",
  },
  "tsforge/no-internal-api-fetch": {
    what: "Server Components must not fetch the app's own /api routes.",
    bad: "await fetch('/api/users');",
    good: "import { listUsers } from '@/services/users'; const users = await listUsers();",
  },
  "tsforge/await-dynamic-request-apis": {
    what: "Await Next.js dynamic request APIs in Server Components.",
    bad: "const jar = cookies();",
    good: "const jar = await cookies();",
  },
  "tsforge/error-boundary-require-use-client": {
    what: "error.tsx and global-error.tsx must be Client Components.",
    bad: "export default function Error() { return <div />; }",
    good: "'use client'; export default function Error() { return <div />; }",
  },
  "tsforge/no-html-img-element": {
    what: "Prefer next/image over raw img elements.",
    bad: "<img src='/hero.jpg' alt='hero' />",
    good: "import Image from 'next/image'; <Image src='/hero.jpg' alt='hero' width={800} height={400} />",
  },
  "tsforge/no-sensitive-next-public-env": {
    what: "NEXT_PUBLIC_* vars are exposed in the client bundle — never use for secrets.",
    bad: "process.env.NEXT_PUBLIC_STRIPE_SECRET",
    good: "process.env.STRIPE_SECRET_KEY // server-only, no NEXT_PUBLIC prefix",
  },
  "tsforge/prefer-lazy-use-state-init": {
    what: "Use lazy useState when parsing localStorage on mount.",
    bad: "useState(JSON.parse(localStorage.getItem('cfg') ?? '{}'))",
    good: "useState(() => JSON.parse(localStorage.getItem('cfg') ?? '{}'))",
  },
  "tsforge/no-auth-token-in-storage": {
    what: "Never store auth tokens in localStorage/sessionStorage.",
    bad: "localStorage.setItem('auth_token', token);",
    good: "Set an httpOnly session cookie on the server instead.",
  },
  "tsforge/fetch-must-check-ok": {
    what: "Check response.ok before calling .json() on fetch results.",
    bad: "const data = await fetch(url).then(r => r.json());",
    good: "const res = await fetch(url); if (!res.ok) { throw new Error('fetch failed'); } const data = await res.json();",
  },
  "tsforge/json-parse-must-validate": {
    what: "Parse external JSON through a schema library, not bare JSON.parse.",
    bad: "const body = JSON.parse(raw);",
    good: "const body = UserSchema.parse(JSON.parse(raw));",
  },
  "tsforge/no-unsafe-boundary-cast": {
    what: "Do not cast untrusted parsed input with `as` — validate at the boundary.",
    bad: "const user = (await req.json()) as IUser;",
    good: "const user = UserSchema.parse(await req.json());",
  },
  "tsforge/no-user-controlled-redirect": {
    what: "Redirect URLs must be string literals or allowlisted helpers — not user input.",
    bad: "redirect(searchParams.get('next')!);",
    good: "redirect('/dashboard');",
  },
  "tsforge/no-user-controlled-fetch-url": {
    what: "fetch/axios URLs must be literals or pass through an allowlisted URL builder.",
    bad: "await fetch(userSuppliedUrl);",
    good: "await fetch('https://api.example.com/v1/status');",
  },
  "tsforge/no-prototype-polluting-merge": {
    what: "Do not merge request body/query/params into objects wholesale.",
    bad: "Object.assign(config, req.body);",
    good: "const name = UserSchema.parse(req.body).name; config.name = name;",
  },
  "tsforge/server-only-modules-import-server-only": {
    what: "Server-only modules importing DB/env must include `import 'server-only'`.",
    bad: "import { db } from '@/lib/db'; // in lib/admin.ts",
    good: "import 'server-only'; import { db } from '@/lib/db';",
  },
  "tsforge/server-action-requires-authz-and-validation": {
    what: "Server actions must validate input and call authz before mutations.",
    bad: "'use server'; export async function deleteUser(id: string) { await db.delete(users).where(eq(users.id, id)); }",
    good: "'use server'; export async function deleteUser(raw: unknown) { const user = await requireUser(); const { id } = IdSchema.parse(raw); await authorize(user, id); ... }",
  },
  "tsforge/require-route-schema": {
    what: "Fastify routes need a schema object with input validation.",
    bad: "fastify.post('/users', async () => ({ ok: true }));",
    good: "fastify.post('/users', { schema: { body: UserSchema } }, async () => ({ ok: true }));",
  },
  "tsforge/require-fastify-plugin-name": {
    what: "fastify-plugin wrappers need a name option.",
    bad: "export default fp(dbPlugin);",
    good: "export default fp(dbPlugin, { name: 'db-connector', fastify: '5.x' });",
  },
  "tsforge/require-elysia-plugin-name": {
    what: "Exported Elysia plugin instances need a name so the runtime can dedupe re-imports.",
    bad: "export const plugin = new Elysia();",
    good: "export const plugin = new Elysia({ name: 'auth-plugin' });",
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

  const errors = [...ids].map((rule) => ({ key: rule, rule, message: "" }));

  return ruleHelp(errors);
}

/** Format the rule docs for whichever rules appear in the current error set. */
export function ruleHelp(errors: ErrorSet): string {
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const e of errors) {
    if (e.rule === undefined || seen.has(e.rule)) {
      continue;
    }

    // Try curated docs first, then generated, then tsforge pack rules
    let doc = RULE_DOCS[e.rule] ?? GENERATED[e.rule];

    if (doc === undefined && e.rule.startsWith("tsforge/")) {
      // For tsforge pack rules, look up in generated docs
      doc = GENERATED[e.rule];
    }

    if (doc === undefined) {
      continue;
    }

    seen.add(e.rule);

    // Only show the ✗/✓ pair when there is a REAL worked example. Generated-only
    // entries (pack rules without a curated example) carry just `what` — a fake
    // "// Example that violates the rule" placeholder is worse than nothing.
    const hasExample = doc.bad.length > 0 && doc.good.length > 0;

    blocks.push(
      hasExample
        ? `${e.rule}: ${doc.what}\n  ✗ ${doc.bad}\n  ✓ ${doc.good}`
        : `${e.rule}: ${doc.what}`
    );
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
