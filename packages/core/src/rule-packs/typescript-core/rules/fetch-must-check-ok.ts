import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";

export const RULE_NAME = "fetch-must-check-ok";

type MessageIds = "missingOkCheck";

/** The two properties that can carry a verdict about the response. They are not
 *  equivalent: `ok` IS the verdict, whereas `status` is a number that has to be
 *  compared before it means anything — see `climb`. */
const OK_PROP = "ok";
const OK_PROPS = new Set([OK_PROP, "status"]);

/** Calls that act as a check even though they are not syntactically a test.
 *
 * Anchored on purpose. An open prefix match would accept `expectedStatus` and
 * `asserted`, letting a plain read masquerade as a check — a false negative in
 * a security gate. A camelCase continuation (`assertResponseOk`) is a real
 * assertion helper and still matches; a lowercase one is a different word. */
const ASSERTION_NAMES =
  /^(?:[Aa]ssert|[Ii]nvariant|[Ee]nsure|[Ee]xpect)(?:[A-Z_]\w*)?$/u;

const COMPARISONS = new Set(["===", "!==", "==", "!=", "<", "<=", ">", ">="]);

/** What a test says about the response when it is true.
 *
 * `res.ok` and `res.status < 400` mean it succeeded; `!res.ok` and
 * `res.status >= 400` mean it failed. Polarity picks which BRANCH is safe to
 * parse in: a body may be read where the response is known good, never where it
 * is known bad — `if (res.ok === false) return res.json()` parses precisely the
 * error payload.
 *
 * `opaque` is a comparison the rule cannot place, such as `res.status === 404`.
 * It guards ONE failure and says nothing about the rest, so it counts as no
 * check at all rather than as a check in whichever direction is convenient. */
type Polarity = "positive" | "negative" | "opaque";

/** Where success ends. 1xx-3xx are not errors; `res.ok` itself is `< 400`. */
const FIRST_ERROR_STATUS = 400;

function literalValue(node: TSESTree.Node): number | boolean | undefined {
  if (node.type !== AST_NODE_TYPES.Literal) {
    return undefined;
  }

  return typeof node.value === "number" || typeof node.value === "boolean"
    ? node.value
    : undefined;
}

/** Read the comparison as if the response were on the left. */
function mirror(operator: string): string {
  switch (operator) {
    case "<":
      return ">";
    case "<=":
      return ">=";
    case ">":
      return "<";
    case ">=":
      return "<=";
    default:
      return operator;
  }
}

function booleanPolarity(operator: string, value: boolean): Polarity {
  if (operator === "===" || operator === "==") {
    return value ? "positive" : "negative";
  }

  if (operator === "!==" || operator === "!=") {
    return value ? "negative" : "positive";
  }

  return "opaque";
}

/** A status comparison only takes a side when it splits success from failure.
 *  `=== 404` does not: it catches one error and lets every other one through. */
function statusPolarity(operator: string, value: number): Polarity {
  const isSuccessCode = value >= 200 && value < 300;

  switch (operator) {
    case "===":
    case "==":
      return isSuccessCode ? "positive" : "opaque";
    case "!==":
    case "!=":
      return isSuccessCode ? "negative" : "opaque";
    case "<":
      return value <= FIRST_ERROR_STATUS ? "positive" : "opaque";
    case "<=":
      return value < FIRST_ERROR_STATUS ? "positive" : "opaque";
    case ">=":
      return value >= 300 ? "negative" : "opaque";
    case ">":
      return value >= 299 ? "negative" : "opaque";
    default:
      return "opaque";
  }
}

/** Which way a comparison points, given which side the response sits on. */
function comparisonPolarity(
  node: TSESTree.BinaryExpression,
  readIsLeft: boolean
): Polarity {
  const value = literalValue(readIsLeft ? node.right : node.left);
  const operator = readIsLeft ? node.operator : mirror(node.operator);

  if (typeof value === "boolean") {
    return booleanPolarity(operator, value);
  }

  return typeof value === "number" ? statusPolarity(operator, value) : "opaque";
}

/** A syntactic check of the response, resolved back to what governs it. */
interface ICheck {
  /** The `if`/ternary/loop, `&&`, or assertion call the read feeds. */
  owner: TSESTree.Node;
  polarity: Polarity;
  /** The read was compared to something, or handed to an assertion. A bare
   *  `if (res.status)` is neither, and is true for 404 as much as for 200. */
  compared: boolean;
  /** The read sits under `&&`, so a guard clause built on it may not run. */
  underAnd: boolean;
}

/** A non-computed `<object>.<prop>` read, e.g. `res.json` or `res.ok`. */
function propReadOn(
  node: TSESTree.Node,
  objectName: string,
  props: ReadonlySet<string> | string
): node is TSESTree.MemberExpression {
  if (node.type !== AST_NODE_TYPES.MemberExpression || node.computed) {
    return false;
  }

  if (
    node.object.type !== AST_NODE_TYPES.Identifier ||
    node.object.name !== objectName ||
    node.property.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }

  const name = node.property.name;

  return typeof props === "string" ? name === props : props.has(name);
}

/** Every `<res>.json` read inside `root`.
 *
 * All of them, not the first: `if (preview) { if (!res.ok) throw; return
 * res.json(); } return res.json();` guards one parse and leaves the other
 * open, and stopping at the first would call the whole function checked. */
function findJsonReads(
  root: TSESTree.Node,
  name: string
): TSESTree.MemberExpression[] {
  const reads: TSESTree.MemberExpression[] = [];

  walkSome(root, (node) => {
    if (propReadOn(node, name, "json")) {
      reads.push(node);
    }

    return false;
  });

  return reads;
}

function isAssertionName(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.Identifier && ASSERTION_NAMES.test(node.name)
  );
}

/** Either half of a member callee can carry the meaning: `assert.ok(res.ok)`
 *  and `assert.equal(res.status, 200)` are named by the RECEIVER, while
 *  `t.assert(res.ok)` is named by the method. */
function isAssertionCallee(callee: TSESTree.Node): boolean {
  if (callee.type === AST_NODE_TYPES.Identifier) {
    return isAssertionName(callee);
  }

  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    (isAssertionName(callee.object) || isAssertionName(callee.property))
  );
}

/** Mutable state carried up the walk. */
interface IClimbState {
  polarity: Polarity;
  compared: boolean;
  underAnd: boolean;
}

/** Nodes that CONSUME a condition. Reaching one ends the walk either way: it
 *  yields a check, or the read was in some other position of it (an `if` body,
 *  a non-assertion argument) and is no check at all. */
const TERMINAL_TYPES = new Set<string>([
  AST_NODE_TYPES.IfStatement,
  AST_NODE_TYPES.WhileStatement,
  AST_NODE_TYPES.DoWhileStatement,
  AST_NODE_TYPES.ConditionalExpression,
  AST_NODE_TYPES.SwitchStatement,
  AST_NODE_TYPES.CallExpression,
]);

function terminalCheck(
  parent: TSESTree.Node,
  child: TSESTree.Node,
  state: IClimbState
): ICheck | null {
  const check = { owner: parent, ...state };

  switch (parent.type) {
    case AST_NODE_TYPES.IfStatement:
    case AST_NODE_TYPES.WhileStatement:
    case AST_NODE_TYPES.DoWhileStatement:
    case AST_NODE_TYPES.ConditionalExpression:
      return parent.test === child ? check : null;

    case AST_NODE_TYPES.SwitchStatement:
      return parent.discriminant === child
        ? { ...check, compared: true, polarity: "opaque" }
        : null;

    // An assertion compares for us when it is GIVEN something to compare
    // against: `assert.equal(res.status, 200)` is a status check, while
    // `assert.ok(res.status)` asserts that a number is truthy — which every
    // response that arrived satisfies, 500 included.
    case AST_NODE_TYPES.CallExpression:
      return isAssertionCallee(parent.callee) && parent.callee !== child
        ? {
            ...check,
            compared: state.compared || parent.arguments.length > 1,
          }
        : null;

    default:
      return null;
  }
}

/** One step through an operator that merely reshapes the condition. Returns
 *  the resolved check when the operator IS the guard (`res.ok && parse`),
 *  "stop" when the read cannot be a condition, "continue" otherwise. */
function combinatorStep(
  parent: TSESTree.Node,
  child: TSESTree.Node,
  state: IClimbState,
  parse: TSESTree.Node
): ICheck | "continue" | "stop" {
  switch (parent.type) {
    case AST_NODE_TYPES.UnaryExpression:
      // `typeof res.status === "number"` inspects the TYPE, which is "number"
      // for 500 exactly as for 200. That is not a check.
      if (parent.operator === "typeof") {
        return "stop";
      }

      if (parent.operator === "!") {
        state.polarity =
          state.polarity === "positive" ? "negative" : "positive";
      }

      return "continue";

    case AST_NODE_TYPES.BinaryExpression: {
      if (!COMPARISONS.has(parent.operator)) {
        return "stop";
      }

      const polarity = comparisonPolarity(parent, parent.left === child);

      state.compared = true;
      // A comparison replaces whatever the walk carried: `res.status >= 400`
      // says failure regardless of how the read got here.
      state.polarity = polarity;

      return polarity === "opaque" ? "stop" : "continue";
    }

    case AST_NODE_TYPES.LogicalExpression:
      if (parent.operator === "&&") {
        state.underAnd = true;
      }

      // `res.ok && res.json()` — the parse is the right operand, so it runs
      // only when the check passed. That is a guard, not just a read. Only
      // when the parse is actually THERE, though: in `if (a || !res.ok)` the
      // operator is part of a larger test, and the walk must go on to the
      // `if` rather than stopping at an operand the parse is nowhere near.
      return parent.left === child && contains(parent.right, parse)
        ? { owner: parent, ...state }
        : "continue";

    case AST_NODE_TYPES.ChainExpression:
    case AST_NODE_TYPES.TSNonNullExpression:
      return "continue";

    default:
      return "stop";
  }
}

/** Walk from a read up to whatever consumes it as a condition, recording what
 *  happened on the way. Returns null when the read is not part of a test at
 *  all — `metrics.observe(res.status)` reads the status and still parses an
 *  error body as data. */
function climb(read: TSESTree.Node, parse: TSESTree.Node): ICheck | null {
  const state: IClimbState = {
    polarity: "positive",
    compared: false,
    underAnd: false,
  };
  let child: TSESTree.Node = read;
  let parent: TSESTree.Node | undefined = read.parent;

  while (parent !== undefined) {
    if (TERMINAL_TYPES.has(parent.type)) {
      return terminalCheck(parent, child, state);
    }

    const step = combinatorStep(parent, child, state, parse);

    if (step === "stop") {
      return null;
    }

    if (step !== "continue") {
      return step;
    }

    child = parent;
    parent = parent.parent;
  }

  return null;
}

function contains(outer: TSESTree.Node, inner: TSESTree.Node): boolean {
  return outer.range[0] <= inner.range[0] && outer.range[1] >= inner.range[1];
}

/** True when control cannot fall out of this statement. A guard clause has to
 *  LEAVE — `if (res.ok) { metrics.hit(); }` inspects the response and then
 *  parses the error body anyway. */
function alwaysExits(node: TSESTree.Node): boolean {
  if (
    node.type === AST_NODE_TYPES.ReturnStatement ||
    node.type === AST_NODE_TYPES.ThrowStatement
  ) {
    return true;
  }

  return (
    node.type === AST_NODE_TYPES.BlockStatement &&
    node.body.some((stmt) => alwaysExits(stmt))
  );
}

/** The block a check's statement sits in. A guard only governs code that
 *  follows it in the same scope: a `throw` inside `if (preview) { ... }` says
 *  nothing about a parse after that block, and a check inside a nested function
 *  says nothing about the caller's response. */
function scopeOfCheck(node: TSESTree.Node): TSESTree.Node {
  let current: TSESTree.Node = node;

  // Program has no parent, so the walk already stops there.
  while (current.parent !== undefined && !current.type.endsWith("Statement")) {
    current = current.parent;
  }

  return current.parent ?? current;
}

/** The `case` arm a parse sits in, when that arm belongs to `owner`. */
function caseArmOf(
  owner: TSESTree.SwitchStatement,
  parse: TSESTree.Node
): TSESTree.SwitchCase | null {
  for (const arm of owner.cases) {
    if (contains(arm, parse)) {
      return arm;
    }
  }

  return null;
}

/** `switch (res.status) { case 200: return res.json(); }` is a real check —
 *  but only for the arms that name a success code. `default:` and `case 500:`
 *  parse an error body. */
function switchArmProtects(
  owner: TSESTree.SwitchStatement,
  parse: TSESTree.Node
): boolean {
  // A `default:` arm has no test, and it is where the error cases land.
  const test = caseArmOf(owner, parse)?.test;

  if (test === undefined || test === null) {
    return false;
  }

  const value = literalValue(test);

  return typeof value === "number" && value >= 200 && value < 300;
}

/** True when the parse sits in a branch this check permits. */
function branchProtects(check: ICheck, parse: TSESTree.Node): boolean {
  const { owner } = check;

  if (owner.type === AST_NODE_TYPES.SwitchStatement) {
    return switchArmProtects(owner, parse);
  }

  if (owner.type === AST_NODE_TYPES.LogicalExpression) {
    if (!contains(owner.right, parse)) {
      return false;
    }

    // `&&` runs the right side when the test HOLDS, `||` when it fails. So
    // `res.ok && res.json()` is a guard and `res.ok || res.json()` is the
    // same parse on exactly the error path.
    if (owner.operator === "&&") {
      return check.polarity === "positive";
    }

    return owner.operator === "||" && check.polarity === "negative";
  }

  if (
    owner.type === AST_NODE_TYPES.WhileStatement ||
    owner.type === AST_NODE_TYPES.DoWhileStatement
  ) {
    return contains(owner.body, parse) && check.polarity === "positive";
  }

  if (
    owner.type !== AST_NODE_TYPES.ConditionalExpression &&
    owner.type !== AST_NODE_TYPES.IfStatement
  ) {
    return false;
  }

  if (contains(owner.consequent, parse)) {
    return check.polarity === "positive";
  }

  return (
    owner.alternate !== null &&
    contains(owner.alternate, parse) &&
    check.polarity === "negative"
  );
}

/** True when the check leaves — throw or return — before the parse is reached,
 *  from a scope that encloses it. */
function guardProtects(check: ICheck, parse: TSESTree.Node): boolean {
  const { owner } = check;

  if (owner.type === AST_NODE_TYPES.CallExpression) {
    return (
      check.polarity === "positive" &&
      owner.range[1] <= parse.range[0] &&
      contains(scopeOfCheck(owner), parse)
    );
  }

  // A guard under `&&` is not guaranteed to run at all.
  if (owner.type !== AST_NODE_TYPES.IfStatement || check.underAnd) {
    return false;
  }

  if (
    owner.range[1] > parse.range[0] ||
    !contains(scopeOfCheck(owner), parse)
  ) {
    return false;
  }

  if (alwaysExits(owner.consequent)) {
    return check.polarity === "negative";
  }

  return (
    owner.alternate !== null &&
    alwaysExits(owner.alternate) &&
    check.polarity === "positive"
  );
}

/** True when this check actually protects `parse`.
 *
 * Two shapes qualify, and merely reading the response is neither of them:
 *
 *   the parse sits in the branch the check permits
 *     `if (res.ok) { return res.json(); }`   `res.ok ? res.json() : null`
 *
 *   the check leaves before the parse is reached
 *     `if (!res.ok) { throw ... } return res.json();`
 */
function protects(check: ICheck, parse: TSESTree.Node): boolean {
  // `res.status` is a number, truthy for every response that arrived. Only a
  // comparison of it says anything about success.
  if (!check.compared) {
    return false;
  }

  return branchProtects(check, parse) || guardProtects(check, parse);
}

/** Names bound directly from the response, mapped to the property they carry —
 *  `const ok = res.ok` is checkable as `ok`, while `const code = res.status`
 *  still has to be compared. */
function statusAliases(root: TSESTree.Node, name: string): Map<string, string> {
  const aliases = new Map<string, string>();

  walkSome(root, (node) => {
    if (
      node.type === AST_NODE_TYPES.VariableDeclarator &&
      node.id.type === AST_NODE_TYPES.Identifier &&
      node.init !== null &&
      propReadOn(node.init, name, OK_PROPS) &&
      node.init.property.type === AST_NODE_TYPES.Identifier
    ) {
      aliases.set(node.id.name, node.init.property.name);
    }

    return false;
  });

  return aliases;
}

/** The property a node checks, or undefined when it checks nothing. */
function checkedProp(
  node: TSESTree.Node,
  name: string,
  aliases: Map<string, string>
): string | undefined {
  if (propReadOn(node, name, OK_PROPS)) {
    return node.property.type === AST_NODE_TYPES.Identifier
      ? node.property.name
      : undefined;
  }

  return node.type === AST_NODE_TYPES.Identifier
    ? aliases.get(node.name)
    : undefined;
}

/** True when some check in `root` protects this parse. */
function isProtected(
  root: TSESTree.Node,
  name: string,
  aliases: Map<string, string>,
  parse: TSESTree.MemberExpression
): boolean {
  return walkSome(root, (node) => {
    const prop = checkedProp(node, name, aliases);

    if (prop === undefined) {
      return false;
    }

    const check = climb(node, parse);

    if (check === null) {
      return false;
    }

    // `ok` is itself the verdict; `status` has to be compared to become one.
    return protects(
      prop === OK_PROP ? { ...check, compared: true } : check,
      parse
    );
  });
}

/** Where to look: the nearest enclosing block or function body. */
function scopeOf(node: TSESTree.Node): TSESTree.Node {
  let current: TSESTree.Node | undefined = node.parent;

  while (current !== undefined) {
    if (
      current.type === AST_NODE_TYPES.BlockStatement ||
      current.type === AST_NODE_TYPES.Program
    ) {
      return current;
    }

    current = current.parent;
  }

  return node;
}

/** Strip the `await` wrapper so `(await fetch(url)).json()` and
 *  `fetch(url).json()` reach the same branch. */
function skipAwait(node: TSESTree.Node | undefined): TSESTree.Node | undefined {
  return node?.type === AST_NODE_TYPES.AwaitExpression ? node.parent : node;
}

/** The response identifier a `.then(res => ...)` callback binds, or null. */
function thenCallbackParam(node: TSESTree.Node): {
  name: string;
  body: TSESTree.Node;
} | null {
  if (
    node.type !== AST_NODE_TYPES.MemberExpression ||
    node.computed ||
    node.property.type !== AST_NODE_TYPES.Identifier ||
    node.property.name !== "then" ||
    node.parent.type !== AST_NODE_TYPES.CallExpression
  ) {
    return null;
  }

  const callback = node.parent.arguments[0];

  if (
    callback === undefined ||
    (callback.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
      callback.type !== AST_NODE_TYPES.FunctionExpression)
  ) {
    return null;
  }

  const param = callback.params[0];

  return param?.type === AST_NODE_TYPES.Identifier
    ? { name: param.name, body: callback.body }
    : null;
}

export const fetchMustCheckOkRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "HTTP fetch responses must check `.ok` or status before calling `.json()`.",
    },
    schema: [],
    messages: {
      missingOkCheck:
        "Check `response.ok` (or status) before calling `.json()` on a fetch response.",
    },
  },
  defaultOptions: [],
  create(context) {
    function reportUnprotected(root: TSESTree.Node, name: string): void {
      const aliases = statusAliases(root, name);

      for (const read of findJsonReads(root, name)) {
        if (!isProtected(root, name, aliases, read)) {
          context.report({ node: read, messageId: "missingOkCheck" });
        }
      }
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;

        if (
          callee.type !== AST_NODE_TYPES.Identifier ||
          callee.name !== "fetch"
        ) {
          return;
        }

        const parent = skipAwait(node.parent);

        if (parent === undefined) {
          return;
        }

        // `fetch(url).json()` / `(await fetch(url)).json()` — the response is
        // never bound, so no check can exist anywhere.
        if (
          parent.type === AST_NODE_TYPES.MemberExpression &&
          !parent.computed &&
          parent.property.type === AST_NODE_TYPES.Identifier &&
          parent.property.name === "json"
        ) {
          context.report({ node: parent, messageId: "missingOkCheck" });

          return;
        }

        // `fetch(url).then(res => res.json())` — the callback parameter is the
        // response, and the callback body is the scope it lives in.
        const callback = thenCallbackParam(parent);

        if (callback !== null) {
          reportUnprotected(callback.body, callback.name);

          return;
        }

        // `const res = await fetch(url); ... res.json()` — the common shape.
        if (
          parent.type !== AST_NODE_TYPES.VariableDeclarator ||
          parent.id.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }

        reportUnprotected(scopeOf(parent), parent.id.name);
      },
    };
  },
});
