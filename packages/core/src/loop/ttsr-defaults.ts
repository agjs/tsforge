import type { ITtsrRule } from "./ttsr";

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
    fileGlobs: ["src/**/*.ts", "src/**/*.tsx"],
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
    fileGlobs: ["src/**/*.ts", "src/**/*.tsx"],
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
    fileGlobs: ["src/**/*.ts", "src/**/*.tsx"],
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
    fileGlobs: ["src/**/*.ts", "src/**/*.tsx"],
    guidance:
      "Remove console.log/debug before shipping. Use a logger or remove the line. " +
      "Tests can call console.log; production code must not.",
    repeatMode: "cooldown",
    repeatGap: 5,
  },
];
