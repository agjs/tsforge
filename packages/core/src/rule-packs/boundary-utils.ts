import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

export function isExpression(node: TSESTree.Node): node is TSESTree.Expression {
  return node.type !== AST_NODE_TYPES.SpreadElement;
}

export function isStringLiteral(node: TSESTree.Expression): boolean {
  return node.type === AST_NODE_TYPES.Literal && typeof node.value === "string";
}

export function isIdentifierNamed(node: TSESTree.Node, name: string): boolean {
  return node.type === AST_NODE_TYPES.Identifier && node.name === name;
}

/**
 * True when a URL expression's ORIGIN is fixed at author time, so no runtime
 * value can redirect the request to a different host.
 *
 * SSRF is control of the *host*, not the path. `fetch(`/api/todos/${id}`)` can
 * only ever reach the current origin however hostile `id` is, so requiring a
 * plain literal forbids the ordinary resource-by-id call for no security gain —
 * and leaves no way to write a REST client at all.
 *
 * What decides it is the FIRST template quasi, because everything before the
 * first `${}` is author-written text:
 *
 *   ok    `/api/todos/${id}`          relative, same origin
 *   ok    `api/todos/${id}`           relative, same origin
 *   ok    `https://api.example.com/v${n}`   authority closed by `/` before `${}`
 *   FLAG  `${base}/api/todos`         empty first quasi — the whole URL is runtime
 *   FLAG  `https://${host}/todos`     expression sits in the host position
 *   FLAG  `//${host}/todos`           protocol-relative: host is still runtime
 *   FLAG  `https://api.example.com${p}`  authority not closed; `p` can start `@evil`
 *
 * The last one is the subtle case: `https://api.example.com${p}` with
 * `p = "@evil.com/x"` resolves to host `evil.com`, because everything before an
 * `@` in the authority is userinfo. So the authority must be terminated by `/`,
 * `?` or `#` inside the literal text.
 */
export function hasFixedOrigin(node: TSESTree.Expression): boolean {
  if (isStringLiteral(node)) {
    return true;
  }

  if (node.type !== AST_NODE_TYPES.TemplateLiteral) {
    return false;
  }

  // No interpolation at all — a template literal that is really just a literal.
  if (node.expressions.length === 0) {
    return true;
  }

  return prefixPinsOrigin(node.quasis[0]?.value.cooked ?? "");
}

/** Whether author-written text before the first `${}` fully determines the origin. */
function prefixPinsOrigin(prefix: string): boolean {
  if (prefix === "") {
    return false;
  }

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(prefix);
  const authorityStart =
    scheme === null ? (prefix.startsWith("//") ? 2 : -1) : scheme[0].length;

  // Relative URL (no scheme, no leading `//`) — cannot change origin.
  if (authorityStart === -1) {
    return true;
  }

  // Absolute or protocol-relative: the authority must END inside the literal
  // text, otherwise the interpolation can extend or hijack the host.
  return /[/?#]/u.test(prefix.slice(authorityStart));
}
