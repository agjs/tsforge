import { ISelectQuery, IExpression } from "./parser";

type RowType = Record<string, string | number | null>;

export function execute(
  query: ISelectQuery,
  rows: readonly RowType[]
): RowType[] {
  let result: RowType[] = Array.from(rows);

  // Apply WHERE filter
  if (query.where !== undefined) {
    result = result.filter((row) => evaluateExpression(query.where, row));
  }

  // Apply ORDER BY with stable sort
  if (query.orderBy) {
    const { column, direction } = query.orderBy;

    result = stableSort(result, (a, b) => {
      const aVal = a[column];
      const bVal = b[column];

      return compareValues(aVal, bVal, direction);
    });
  }

  // Apply LIMIT
  if (query.limit !== undefined) {
    result = result.slice(0, query.limit);
  }

  // Apply column projection
  const projected = projectColumns(result, query.columns);

  return projected;
}

function evaluateExpression(expr: IExpression, row: RowType): boolean {
  if (expr.type === "comparison") {
    const val = row[expr.column];

    return compareColumn(val, expr.operator, expr.value);
  }

  if (expr.type === "and") {
    return (
      evaluateExpression(expr.left, row) && evaluateExpression(expr.right, row)
    );
  }

  if (expr.type === "or") {
    return (
      evaluateExpression(expr.left, row) || evaluateExpression(expr.right, row)
    );
  }

  // This should never happen with proper type guards
  throw new Error("Unknown expression type");
}

function compareColumn(
  columnVal: string | number | null,
  operator: "=" | "!=" | "<" | ">" | "<=" | ">=",
  compareVal: string | number | null
): boolean {
  // NULL semantics:
  // - x = null → always false (incl null = null)
  // - x != null → true if x is not null, false if x is null
  // - x <,>,<=,>= null → always false
  if (compareVal === null) {
    if (operator === "=") {
      return false;
    }

    if (operator === "!=") {
      return columnVal !== null; // true if column is not null
    }

    // For <, >, <=, >= with null, return false
    return false;
  }

  // If column is null and compare value is not null
  if (columnVal === null) {
    return false; // null is not equal to any non-null value
  }

  // Cross-type comparisons: string vs number
  // Treat numeric strings as numbers if comparing to numbers
  if (typeof columnVal === "string" && typeof compareVal === "number") {
    const numVal = Number(columnVal);

    if (!Number.isNaN(numVal)) {
      columnVal = numVal;
    }
  } else if (typeof columnVal === "number" && typeof compareVal === "string") {
    const numVal = Number(compareVal);

    if (!Number.isNaN(numVal)) {
      compareVal = numVal;
    }
  }

  switch (operator) {
    case "=":
      return columnVal === compareVal;
    case "!=":
      return columnVal !== compareVal;
    case "<":
      return columnVal < compareVal;
    case ">":
      return columnVal > compareVal;
    case "<=":
      return columnVal <= compareVal;
    case ">=":
      return columnVal >= compareVal;
    default:
      throw new Error(`Unknown operator: ${operator}`);
  }
}

function compareValues(
  a: string | number | null,
  b: string | number | null,
  direction: "ASC" | "DESC"
): number {
  // Nulls go last regardless of direction
  if (a === null && b === null) {
    return 0;
  }

  if (a === null) {
    return 1; // a goes after b (last position)
  }

  if (b === null) {
    return -1; // b goes after a (last position)
  }

  // Numeric comparison if both look like numbers
  const aNum = typeof a === "number" ? a : Number(a);
  const bNum = typeof b === "number" ? b : Number(b);

  if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
    const cmp = aNum - bNum;

    return direction === "ASC" ? cmp : -cmp;
  }

  // String comparison
  const aStr = String(a);
  const bStr = String(b);
  const cmp = aStr.localeCompare(bStr);

  return direction === "ASC" ? cmp : -cmp;
}

function stableSort<T>(arr: T[], compareFn: (a: T, b: T) => number): T[] {
  const indexed = arr.map((val, idx) => ({ val, idx }));

  indexed.sort((a, b) => {
    const cmp = compareFn(a.val, b.val);

    return cmp !== 0 ? cmp : a.idx - b.idx; // Use original index as tiebreaker for stability
  });

  return indexed.map((item) => item.val);
}

function projectColumns(
  rows: RowType[],
  columns: readonly string[]
): RowType[] {
  return rows.map((row) => {
    if (columns[0] === "*") {
      return { ...row };
    }

    const projected: RowType = {};

    for (const col of columns) {
      // Validate column exists in row
      if (!(col in row)) {
        throw new Error(`Column ${col} not found in row`);
      }

      projected[col] = row[col];
    }

    return projected;
  });
}
