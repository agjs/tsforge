import type { IMetaRuleContext } from "../../meta-rules.types";

/** One meaningful Dockerfile instruction line (comments + blanks stripped). */
export interface IDockerLine {
  readonly file: string;
  readonly lineNo: number; // 1-based
  readonly instruction: string; // upper-cased keyword, e.g. "FROM"
  readonly args: string; // everything after the keyword, trimmed
  readonly raw: string;
}

const INSTRUCTION_PATTERN = /^\s*(?<keyword>[A-Za-z]+)\s+(?<args>.*\S)\s*$/u;

/** Parse every Dockerfile in the context into instruction lines. Continuation
 *  lines (`\` at EOL) and comments are skipped — good enough for the textual
 *  hardening checks (base-image pin, USER, secret literals). */
export function dockerInstructionLines(
  ctx: Pick<IMetaRuleContext, "dockerfiles" | "readFile">
): IDockerLine[] {
  const out: IDockerLine[] = [];

  for (const file of ctx.dockerfiles) {
    const text = ctx.readFile(file);

    if (text === null) {
      continue;
    }

    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] ?? "";
      const trimmed = raw.trim();

      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }

      const match = INSTRUCTION_PATTERN.exec(raw);
      const keyword = match?.groups?.keyword;
      const args = match?.groups?.args;

      if (keyword === undefined || args === undefined) {
        continue;
      }

      out.push({
        file,
        lineNo: i + 1,
        instruction: keyword.toUpperCase(),
        args: args.trim(),
        raw,
      });
    }
  }

  return out;
}
