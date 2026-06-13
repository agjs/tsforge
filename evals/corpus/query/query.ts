import { lex } from "./lexer";
import { parse } from "./parser";
import { execute } from "./executor";

type RowType = Record<string, string | number | null>;

export function query(
  queryString: string,
  rows: readonly RowType[]
): RowType[] {
  if (!queryString || queryString.trim() === "") {
    throw new Error("Query cannot be empty");
  }

  const tokens = lex(queryString);
  const ast = parse(tokens);
  return execute(ast, rows);
}
