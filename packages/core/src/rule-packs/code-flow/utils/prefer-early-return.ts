import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { SourceCode } from "@typescript-eslint/utils/ts-eslint";

const FLIPPABLE_OPERATORS = new Map<string, string>([
  ["===", "!=="],
  ["!==", "==="],
  ["==", "!="],
  ["!=", "=="],
  ["<", ">="],
  [">", "<="],
  ["<=", ">"],
  [">=", "<"],
]);

const MIN_CONSEQUENT_STATEMENTS = 2;

export function getFunctionBlockBody(
  node:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression
): TSESTree.BlockStatement | null {
  if (node.body.type !== AST_NODE_TYPES.BlockStatement) {
    return null;
  }

  return node.body;
}

export function findWrappedHappyPathIf(
  body: TSESTree.BlockStatement
): TSESTree.IfStatement | null {
  if (body.body.length === 0) {
    return null;
  }

  const lastStatement = body.body[body.body.length - 1];

  if (lastStatement?.type !== AST_NODE_TYPES.IfStatement) {
    return null;
  }

  if (lastStatement.alternate !== null) {
    return null;
  }

  if (lastStatement.consequent.type !== AST_NODE_TYPES.BlockStatement) {
    return null;
  }

  if (lastStatement.consequent.body.length < MIN_CONSEQUENT_STATEMENTS) {
    return null;
  }

  return lastStatement;
}

export function negateTestExpression(
  sourceCode: SourceCode,
  test: TSESTree.Expression
): string {
  if (test.type === AST_NODE_TYPES.UnaryExpression && test.operator === "!") {
    return sourceCode.getText(test.argument);
  }

  if (
    test.type === AST_NODE_TYPES.Identifier ||
    test.type === AST_NODE_TYPES.MemberExpression ||
    test.type === "ChainExpression"
  ) {
    return `!${sourceCode.getText(test)}`;
  }

  if (test.type === AST_NODE_TYPES.BinaryExpression) {
    const flipped = FLIPPABLE_OPERATORS.get(test.operator);

    if (flipped !== undefined) {
      return `${sourceCode.getText(test.left)} ${flipped} ${sourceCode.getText(test.right)}`;
    }
  }

  if (test.type === AST_NODE_TYPES.LogicalExpression) {
    if (test.operator === "&&") {
      return `${negateOperand(sourceCode, test.left)} || ${negateOperand(sourceCode, test.right)}`;
    }

    if (test.operator === "||") {
      return `${negateOperand(sourceCode, test.left)} && ${negateOperand(sourceCode, test.right)}`;
    }
  }

  return `!(${sourceCode.getText(test)})`;
}

function negateOperand(
  sourceCode: SourceCode,
  node: TSESTree.Expression
): string {
  const negated = negateTestExpression(sourceCode, node);

  if (needsParentheses(node)) {
    return `(${negated})`;
  }

  return negated;
}

function needsParentheses(node: TSESTree.Expression): boolean {
  return (
    node.type === AST_NODE_TYPES.BinaryExpression ||
    node.type === AST_NODE_TYPES.LogicalExpression ||
    node.type === AST_NODE_TYPES.ConditionalExpression ||
    node.type === AST_NODE_TYPES.AssignmentExpression
  );
}

export function buildGuardClauseReplacement(
  sourceCode: SourceCode,
  ifStatement: TSESTree.IfStatement
): string | null {
  if (ifStatement.consequent.type !== AST_NODE_TYPES.BlockStatement) {
    return null;
  }

  const invertedTest = negateTestExpression(sourceCode, ifStatement.test);
  const guardClause = `if (${invertedTest}) {\n  return;\n}\n`;
  const hoistedBody = ifStatement.consequent.body
    .map((statement) => sourceCode.getText(statement))
    .join("\n");

  return `${guardClause}\n${hoistedBody}`;
}
