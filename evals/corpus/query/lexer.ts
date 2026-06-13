export interface IToken {
  readonly type: string;
  readonly value: string | number;
}

interface IKeywordToken extends IToken {
  readonly type: "keyword";
  readonly value:
    | "SELECT"
    | "FROM"
    | "WHERE"
    | "ORDER"
    | "BY"
    | "AND"
    | "OR"
    | "ASC"
    | "DESC"
    | "LIMIT";
}

interface IIdentifierToken extends IToken {
  readonly type: "identifier";
  readonly value: string;
}

interface INumberToken extends IToken {
  readonly type: "number";
  readonly value: number;
}

interface IStringToken extends IToken {
  readonly type: "string";
  readonly value: string;
}

interface IOperatorToken extends IToken {
  readonly type: "operator";
  readonly value: "=" | "!=" | "<" | ">" | "<=" | ">=";
}

interface IDelimiterToken extends IToken {
  readonly type: "delimiter";
  readonly value: "(" | ")" | "," | "*";
}

interface INullToken extends IToken {
  readonly type: "null";
  readonly value: null;
}

export type Token =
  | IKeywordToken
  | IIdentifierToken
  | INumberToken
  | IStringToken
  | IOperatorToken
  | IDelimiterToken
  | INullToken;

const KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "ORDER",
  "BY",
  "AND",
  "OR",
  "ASC",
  "DESC",
  "LIMIT",
]);

export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) {
      i += 1;
      continue;
    }

    // String literals (single quotes)
    if (input[i] === "'") {
      i += 1;
      let stringValue = "";
      while (i < input.length && input[i] !== "'") {
        stringValue += input[i];
        i += 1;
      }
      if (i >= input.length) {
        throw new Error("Unterminated string literal");
      }
      i += 1; // closing quote
      tokens.push({ type: "string", value: stringValue });
      continue;
    }

    // Operators (two-char first)
    if (i + 1 < input.length) {
      const twoChar = input.substring(i, i + 2);
      if (twoChar === "!=") {
        tokens.push({ type: "operator", value: "!=" });
        i += 2;
        continue;
      }
      if (twoChar === "<=") {
        tokens.push({ type: "operator", value: "<=" });
        i += 2;
        continue;
      }
      if (twoChar === ">=") {
        tokens.push({ type: "operator", value: ">=" });
        i += 2;
        continue;
      }
    }

    // Single-char operators
    if (input[i] === "=") {
      tokens.push({ type: "operator", value: "=" });
      i += 1;
      continue;
    }
    if (input[i] === "<") {
      tokens.push({ type: "operator", value: "<" });
      i += 1;
      continue;
    }
    if (input[i] === ">") {
      tokens.push({ type: "operator", value: ">" });
      i += 1;
      continue;
    }

    // Delimiters
    if (input[i] === "(") {
      tokens.push({ type: "delimiter", value: "(" });
      i += 1;
      continue;
    }
    if (input[i] === ")") {
      tokens.push({ type: "delimiter", value: ")" });
      i += 1;
      continue;
    }
    if (input[i] === ",") {
      tokens.push({ type: "delimiter", value: "," });
      i += 1;
      continue;
    }
    if (input[i] === "*") {
      tokens.push({ type: "delimiter", value: "*" });
      i += 1;
      continue;
    }

    // Numbers
    if (/\d/.test(input[i])) {
      let numStr = "";
      while (i < input.length && /\d/.test(input[i])) {
        numStr += input[i];
        i += 1;
      }
      tokens.push({ type: "number", value: Number(numStr) });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(input[i])) {
      let ident = "";
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) {
        ident += input[i];
        i += 1;
      }

      const upper = ident.toUpperCase();
      if (upper === "SELECT") {
        tokens.push({ type: "keyword", value: "SELECT" });
      } else if (upper === "FROM") {
        tokens.push({ type: "keyword", value: "FROM" });
      } else if (upper === "WHERE") {
        tokens.push({ type: "keyword", value: "WHERE" });
      } else if (upper === "ORDER") {
        tokens.push({ type: "keyword", value: "ORDER" });
      } else if (upper === "BY") {
        tokens.push({ type: "keyword", value: "BY" });
      } else if (upper === "AND") {
        tokens.push({ type: "keyword", value: "AND" });
      } else if (upper === "OR") {
        tokens.push({ type: "keyword", value: "OR" });
      } else if (upper === "ASC") {
        tokens.push({ type: "keyword", value: "ASC" });
      } else if (upper === "DESC") {
        tokens.push({ type: "keyword", value: "DESC" });
      } else if (upper === "LIMIT") {
        tokens.push({ type: "keyword", value: "LIMIT" });
      } else if (upper === "NULL") {
        tokens.push({ type: "null", value: null });
      } else {
        tokens.push({ type: "identifier", value: ident });
      }
      continue;
    }

    throw new Error(`Unexpected character: ${input[i]}`);
  }

  return tokens;
}
