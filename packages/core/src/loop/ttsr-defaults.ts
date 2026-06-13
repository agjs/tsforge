import type { ITtsrRule } from "./ttsr";

const SRC_TS_GLOBS = ["src/**/*.ts", "src/**/*.tsx"] as const;
const SRC_TSX_GLOBS = ["src/**/*.tsx"] as const;

/**
 * Built-in TTSR rules: code quality patterns to abort and correct.
 * All scope tool-args (source of the problem), fileGlobs target src/**\/*.ts(x).
 * Each rule guides the model toward the matching gate rule.
 */
export const DEFAULT_TTSR_RULES: readonly ITtsrRule[] = [
  {
    name: "no-as-any",
    condition: [/\bas\s+any\b/],
    scope: "tool-args",
    fileGlobs: [...SRC_TS_GLOBS],
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
