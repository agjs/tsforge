import type { ITtsrRule } from "./ttsr";

const SRC_TS_GLOBS = ["src/**/*.ts", "src/**/*.tsx"] as const;
const SRC_TSX_GLOBS = ["src/**/*.tsx"] as const;

/**
 * Built-in TTSR rules: code quality patterns to abort and correct.
 * All scope tool-args (source of the problem), fileGlobs target src/**\/*.ts(x).
 * Each rule guides the model toward the matching gate rule.
 */
export const DEFAULT_TTSR_RULES: readonly ITtsrRule[] = [
  // Universal house-rule bans — the harness ALREADY forbids these, so stop the
  // model mid-stream instead of "learning" them from repeated gate failures. NO
  // fileGlobs (they apply to every file, incl. tests) — which also sidesteps the
  // `src/**`-glob matcher quirk that dead-ends path-scoped rules in a monorepo.
  {
    name: "no-as-cast",
    // `as <type>` — `unknown`/`any`/primitive/PascalType/`{`/`[`/`(`. Excludes the
    // one legal form, `as const` (lowercase, not in the alternation), and prose
    // like "…as the…" (lowercase non-keyword).
    //
    // Guards against the false positives that made this rule gaslight the model
    // (it fired on text that contained no cast at all):
    //   1. Import/export RENAMES are legal `as` — `import * as React`,
    //      `import { Foo as Bar }`, `export { a as B }`. Two lookbehinds drop
    //      anything after `import` up to its terminating `;` (imports can't
    //      contain casts, and the window crosses JSON-escaped newlines in
    //      multi-line imports), and after `export {`/`export type {` up to `}`.
    //      `export const x = y as T` is NOT excluded (no `{` after export).
    //      No leading \b on import/export: after a JSON-escaped newline the
    //      text is `\nimport` and the escape's `n` glues onto the keyword
    //      ("nimport" — no word boundary), which made the lookbehind miss
    //      every import after the first line. Suffix-matching over-blocks only
    //      odd identifiers ending in "import", and only until the next `;`.
    //   2. PROSE — "such as React components", "save this as README.md". A real
    //      cast's type is followed by a code delimiter (`;` `,` `)` `]` `}` `<`
    //      `:` `&` `|` `?` `=` or a backslash, which is how a JSON-escaped
    //      newline/quote appears on this channel — TTSR scans the RAW tool-args
    //      string); prose is followed by another word. No `$`: at a chunk
    //      boundary the delimiter simply arrives with the next delta (the
    //      rolling buffer persists), whereas matching at end-of-buffer would
    //      fire mid-sentence.
    //   3. Sentence dots — `[A-Z]\w*(?:\.\w+)*` (not `[\w.]*`) so the `.` ending
    //      "known as React." can't backtrack into the delimiter lookahead.
    condition: [
      /(?<!import\b[^;]{0,300})(?<!export\s+(?:type\s+)?\{[^}]{0,200})\bas\s+(?:(?:unknown|any|string|number|boolean|bigint|symbol|object|never|[A-Z]\w*(?:\.\w+)*)\s{0,3}(?=[;,)\]}<:&|?=\\])|[[{(])/,
    ],
    scope: "tool-args",
    guidance:
      "No `as` type casts — only `as const` is allowed. Type the value properly: " +
      "annotate the parameter/return, narrow with a type guard (`if (x === undefined) …`), " +
      "or fix the source type. `as any`/`as unknown` are never acceptable.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-eslint-disable",
    condition: [/eslint-disable/],
    scope: "tool-args",
    guidance:
      "Never add `eslint-disable` / `eslint-disable-next-line`. Fix the underlying " +
      "violation — the gate rejects any disabled rule.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-as-any",
    // Same delimiter lookahead as no-as-cast: a real `as any` cast is followed
    // by a code delimiter (or an escaped newline/quote, i.e. a backslash on the
    // raw tool-args channel); the ENGLISH phrase "as any developer knows" is
    // followed by a word and must not abort the stream.
    condition: [/\bas\s+any\b\s{0,3}(?=[;,)\]}<:&|?=\\])/],
    scope: "tool-args",
    guidance:
      "Never use 'as any'. If the type is unknown, use 'unknown' or a proper type. " +
      "If the API is untyped, consider a declaration file.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-ts-suppression",
    condition: [/@ts-(?:ignore|nocheck)/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Never suppress TypeScript with @ts-ignore/@ts-nocheck. Fix the real error; " +
      "if the library is untyped, add a declaration file instead.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-empty-catch",
    condition: [/catch\s*(?:\([^)]*\))?\s*\{\s*\}/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Empty catch blocks hide errors. Log them or handle them: " +
      "catch (e) { console.error(e); } at minimum.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-console-log",
    condition: [/\bconsole\.(?:log|debug)\s*\(/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Remove console.log/debug before shipping. Use a logger or remove the line. " +
      "Tests can call console.log; production code must not.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-react-fc",
    condition: [
      /React\.(?:FC|FunctionComponent|VFC)\b/,
      /\bFunctionComponent\s*</,
    ],
    scope: "tool-args",
    fileGlobs: [...SRC_TSX_GLOBS],
    guidance:
      "Do not use React.FC — type props explicitly on the function parameter instead.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-throw-literal",
    condition: [/throw\s+['"`]/, /throw\s+\d+/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Do not throw string/number literals — throw `new Error('...')` so error handlers propagate correctly.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "dangerous-html-unsanitized",
    condition: [/dangerouslySetInnerHTML/],
    scope: "tool-args",
    fileGlobs: [...SRC_TSX_GLOBS],
    guidance:
      "dangerouslySetInnerHTML requires sanitizing with DOMPurify (or isomorphic-dompurify) before rendering.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-child-process-exec",
    condition: [/\bchild_process\.exec\b/, /\bexecSync\s*\(/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Do not use child_process.exec/execSync — use execFile or spawn without shell to avoid command injection.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-inner-html-assignment",
    condition: [/\.innerHTML\s*=/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Do not assign to innerHTML — use textContent for plain text or sanitize with DOMPurify first.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-dynamic-regexp",
    condition: [/new RegExp\s*\(\s*(?!['"`])/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Do not construct RegExp from runtime values — use a string-literal pattern or a safe regex library to avoid ReDoS.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-internal-api-fetch",
    condition: [/fetch\s*\(\s*['"`]\/api/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Server Components must not fetch /api routes — import the service or ORM module directly.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-unawaited-cookies",
    condition: [/(?<![\w.])cookies\s*\(\s*\)/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Await dynamic request APIs: `const jar = await cookies()` in Server Components.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-html-img",
    condition: [/<img[\s/>]/],
    scope: "tool-args",
    fileGlobs: [...SRC_TSX_GLOBS],
    guidance:
      "Use next/image `<Image />` instead of raw `<img>` for optimized responsive images.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-sensitive-next-public-env",
    condition: [
      /NEXT_PUBLIC_(?:.*(?:SECRET|PRIVATE|PASSWORD|TOKEN|DATABASE|STRIPE|KEY))/i,
    ],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Never prefix secret env vars with NEXT_PUBLIC_ — they are embedded in the client bundle.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-auth-token-in-storage",
    condition: [
      /localStorage\.(?:setItem|getItem).*(?:token|session|auth|jwt)/i,
      /sessionStorage\.(?:setItem|getItem).*(?:token|session|auth|jwt)/i,
    ],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Do not store auth tokens in localStorage — use httpOnly secure cookies instead.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-user-controlled-redirect",
    condition: [/redirect\s*\(\s*(?!['"`])/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Do not redirect to a runtime URL — use a string literal path or an allowlisted helper.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "fetch-without-ok-check",
    condition: [/\.json\s*\(\s*\)/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Check response.ok (or status) before calling .json() on a fetch response.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "server-only-missing",
    condition: [/from\s+['"]@\/lib\/(?:db|database|auth)/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Add `import 'server-only';` at the top of modules that import DB or auth internals.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "server-action-without-parse",
    condition: [/"use server"[\s\S]{0,200}(?:update|insert|delete)\s*\(/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
    guidance:
      "Server actions must call `.parse(` or `.safeParse(` on input before database writes.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
  {
    name: "no-secret-props-to-client",
    condition: [/(?:token|session|password|secret)=\{/i],
    scope: "tool-args",
    fileGlobs: [...SRC_TSX_GLOBS],
    guidance:
      "Do not pass session/token/password props from Server Components to Client Components.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
];
