import { Token } from "./lexer";

function isOperatorValue(
  val: string
): val is "=" | "!=" | "<" | ">" | "<=" | ">=" {
  return (
    val === "=" ||
    val === "!=" ||
    val === "<" ||
    val === ">" ||
    val === "<=" ||
    val === ">="
  );
}

export interface ISelectQuery {
  readonly type: "select";
  readonly columns: readonly string[];
  readonly table: string;
  readonly where?: IExpression;
  readonly orderBy?: {
    readonly column: string;
    readonly direction: "ASC" | "DESC";
  };
  readonly limit?: number;
}

export interface IComparison {
  readonly type: "comparison";
  readonly column: string;
  readonly operator: "=" | "!=" | "<" | ">" | "<=" | ">=";
  readonly value: string | number | null;
}

export interface IAndExpr {
  readonly type: "and";
  readonly left: IExpression;
  readonly right: IExpression;
}

export interface IOrExpr {
  readonly type: "or";
  readonly left: IExpression;
  readonly right: IExpression;
}

export type IExpression = IComparison | IAndExpr | IOrExpr;

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private current(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): void {
    this.pos += 1;
  }

  private expect(type: string, value?: string | number | null): Token {
    const token = this.current();
    if (!token || token.type !== type) {
      throw new Error(`Expected ${type}, got ${token?.type}`);
    }
    if (value !== undefined && token.value !== value) {
      throw new Error(`Expected value ${value}, got ${token.value}`);
    }
    this.advance();
    return token;
  }

  private isKeyword(value?: string): boolean {
    const token = this.current();
    return (
      token?.type === "keyword" &&
      (value === undefined || token.value === value)
    );
  }

  private isOperator(): boolean {
    return this.current()?.type === "operator";
  }

  parse(): ISelectQuery {
    if (!this.isKeyword("SELECT")) {
      throw new Error("Query must start with SELECT");
    }
    this.advance();

    const columns = this.parseColumns();

    if (!this.isKeyword("FROM")) {
      throw new Error("Expected FROM clause");
    }
    this.advance();

    const table = this.parseIdentifier();

    let where: IExpression | undefined;
    if (this.isKeyword("WHERE")) {
      this.advance();
      where = this.parseOrExpression();
    }

    let orderBy:
      | { readonly column: string; readonly direction: "ASC" | "DESC" }
      | undefined;
    if (this.isKeyword("ORDER")) {
      this.advance();
      if (!this.isKeyword("BY")) {
        throw new Error("Expected BY after ORDER");
      }
      this.advance();
      const column = this.parseIdentifier();
      let direction: "ASC" | "DESC" = "ASC";
      if (this.isKeyword("ASC")) {
        this.advance();
      } else if (this.isKeyword("DESC")) {
        this.advance();
        direction = "DESC";
      }
      orderBy = { column, direction };
    }

    let limit: number | undefined;
    if (this.isKeyword("LIMIT")) {
      this.advance();
      const token = this.expect("number");
      if (typeof token.value !== "number") {
        throw new Error("LIMIT value must be a number");
      }
      limit = token.value;
    }

    if (this.current() !== undefined) {
      throw new Error(`Unexpected token: ${this.current()?.value}`);
    }

    return { type: "select", columns, table, where, orderBy, limit };
  }

  private parseColumns(): string[] {
    const columns: string[] = [];

    if (this.current()?.type === "delimiter" && this.current()?.value === "*") {
      this.advance();
      return ["*"];
    }

    columns.push(this.parseIdentifier());

    while (
      this.current()?.type === "delimiter" &&
      this.current()?.value === ","
    ) {
      this.advance();
      columns.push(this.parseIdentifier());
    }

    return columns;
  }

  private parseIdentifier(): string {
    const token = this.expect("identifier");
    if (typeof token.value !== "string") {
      throw new Error("Expected identifier");
    }
    return token.value;
  }

  private parseOrExpression(): IExpression {
    let left = this.parseAndExpression();

    while (this.isKeyword("OR")) {
      this.advance();
      const right = this.parseAndExpression();
      left = { type: "or", left, right };
    }

    return left;
  }

  private parseAndExpression(): IExpression {
    let left = this.parsePrimaryExpression();

    while (this.isKeyword("AND")) {
      this.advance();
      const right = this.parsePrimaryExpression();
      left = { type: "and", left, right };
    }

    return left;
  }

  private parsePrimaryExpression(): IExpression {
    // Handle parenthesized expressions
    if (this.current()?.type === "delimiter" && this.current()?.value === "(") {
      this.advance();
      const expr = this.parseOrExpression();
      if (
        this.current()?.type !== "delimiter" ||
        this.current()?.value !== ")"
      ) {
        throw new Error("Expected closing parenthesis");
      }
      this.advance();
      return expr;
    }

    // Comparison: column OP value
    const column = this.parseIdentifier();

    if (!this.isOperator()) {
      throw new Error(`Expected operator after column ${column}`);
    }

    const opToken = this.expect("operator");
    if (typeof opToken.value !== "string") {
      throw new Error("Expected operator");
    }
    if (!isOperatorValue(opToken.value)) {
      throw new Error("Invalid operator");
    }
    const operator = opToken.value;

    let value: string | number | null;
    const token = this.current();

    if (!token) {
      throw new Error("Expected value after operator");
    }

    if (token.type === "string") {
      this.advance();
      if (typeof token.value !== "string") {
        throw new Error("Expected string value");
      }
      value = token.value;
    } else if (token.type === "number") {
      this.advance();
      if (typeof token.value !== "number") {
        throw new Error("Expected number value");
      }
      value = token.value;
    } else if (token.type === "null") {
      this.advance();
      value = null;
    } else {
      throw new Error(`Unexpected token type in comparison: ${token.type}`);
    }

    return { type: "comparison", column, operator, value };
  }
}

export function parse(tokens: Token[]): ISelectQuery {
  return new Parser(tokens).parse();
}
