// A test-only external plugin module: exports a valid rule pack, a colliding
// pack (reuses a built-in rule name), and a non-pack export the loader must skip.
import { createRule } from "../../src/rule-packs/create-rule";
import type { IRulePack } from "../../src/rule-packs/rule-packs.types";

const noFooIdentifier = createRule<[], "noFoo">({
  name: "no-foo-identifier",
  meta: {
    type: "problem",
    docs: { description: "Disallow identifiers named 'foo'." },
    schema: [],
    messages: { noFoo: "Do not name identifiers 'foo'." },
  },
  defaultOptions: [],
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "foo") {
          context.report({ node, messageId: "noFoo" });
        }
      },
    };
  },
});

export const examplePack: IRulePack = {
  id: "example-external",
  description: "A test external rule pack.",
  rules: { "no-foo-identifier": noFooIdentifier },
  rulesConfig: { "no-foo-identifier": "error" },
};

export const collidingPack: IRulePack = {
  id: "example-collision",
  description: "Defines a rule name that collides with a built-in pack.",
  rules: { "no-import-build-output": noFooIdentifier },
  rulesConfig: { "no-import-build-output": "error" },
};

export const notAPack = { hello: "world" };
