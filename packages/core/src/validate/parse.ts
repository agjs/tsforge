import type { IErrorItem } from "./errors";
import { isArray, isRecord } from "../lib/guards";

const TSC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

/** Parse `tsc` output into a structured error set (one item per diagnostic). */
export function parseTsc(output: string): IErrorItem[] {
  const items: IErrorItem[] = [];

  for (const line of output.split("\n")) {
    const m = TSC.exec(line);

    if (!m) {
      continue;
    }

    const [, file, lineStr, , rule, message] = m;

    if (
      file === undefined ||
      lineStr === undefined ||
      rule === undefined ||
      message === undefined
    ) {
      continue;
    }

    items.push({
      key: `${file}:${lineStr}:${rule}`,
      file,
      line: Number(lineStr),
      rule,
      message: message.trim(),
    });
  }

  return items;
}

/** Fallback when we have no tool-specific parser: the whole output is one error. */
export function genericErrors(output: string): IErrorItem[] {
  const text = output.trim();

  return text.length > 0 ? [{ key: "raw", message: text.slice(0, 500) }] : [];
}

/**
 * Parse `eslint --format json`. Errors (severity 2) only; warnings ignored.
 * Carries the `ruleId` — including custom plugin rules like
 * `@boring-stack/structured-logging` — so the repair loop sees exactly which
 * rule failed. Narrowed with guards (no type assertions).
 */
export function parseEslintJson(output: string): IErrorItem[] {
  let data: unknown;

  try {
    data = JSON.parse(output);
  } catch {
    return [];
  }

  if (!isArray(data)) {
    return [];
  }

  const items: IErrorItem[] = [];

  for (const file of data) {
    if (!isRecord(file)) {
      continue;
    }

    const filePath = typeof file.filePath === "string" ? file.filePath : "";
    const messages = file.messages;

    if (!isArray(messages)) {
      continue;
    }

    for (const m of messages) {
      if (!isRecord(m) || m.severity !== 2) {
        continue;
      }

      const rule = typeof m.ruleId === "string" ? m.ruleId : "syntax";
      const lineNo = typeof m.line === "number" ? m.line : undefined;
      const message = typeof m.message === "string" ? m.message : "";

      items.push({
        key: `${filePath}:${lineNo ?? 0}:${rule}`,
        file: filePath,
        line: lineNo,
        rule,
        message: message.trim(),
      });
    }
  }

  return items;
}

export type ErrorParserFn = (output: string) => IErrorItem[];

/**
 * For chained gates like `tsc -p … && eslint --format json … && bun test`,
 * `&&` short-circuits: when tsc fails the output is tsc's TEXT (eslint never
 * ran), and when it passes the output is eslint's JSON. A single tool-specific
 * parser is wrong for both phases — pick eslint-json and tsc-text output parses
 * to nothing (so the whole wall dumps as one blob); pick tsc and eslint's JSON
 * is missed. Run BOTH and union: their formats don't overlap (tsc-text vs JSON),
 * and only one is ever present at a time, so this is lossless either way.
 */
export function combinedParser(output: string): IErrorItem[] {
  const merged = [...parseTsc(output), ...parseEslintJson(output)];
  const seen = new Set<string>();

  return merged.filter((e) => {
    if (seen.has(e.key)) {
      return false;
    }

    seen.add(e.key);

    return true;
  });
}

/** Pick a parser from the command. Add tools here as we support them. */
export function parserFor(command: string): ErrorParserFn {
  const hasTsc = /\btsc\b/.test(command);
  const hasEslint = /\beslint\b/.test(command);

  // A chained tsc+eslint gate needs the combined parser (see above).
  if (hasTsc && hasEslint) {
    return combinedParser;
  }

  if (hasEslint) {
    return parseEslintJson;
  }

  if (hasTsc) {
    return parseTsc;
  }

  return genericErrors;
}
