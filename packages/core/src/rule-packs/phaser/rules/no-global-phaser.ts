import { createRule } from "../../create-rule";
import {
  analyzePhaserImports,
  isImportedPhaserBinding,
  isNonValueIdentifier,
  isPhaserPackageSource,
  requireSource,
} from "../utils";

export const RULE_NAME = "no-global-phaser";

type MessageIds = "globalPhaser" | "requirePhaser";

export const noGlobalPhaserRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Do not rely on a script-tag global `Phaser` identifier or `require('phaser')`. Import from the `phaser` package so the runtime is one module graph.",
    },
    schema: [],
    messages: {
      globalPhaser:
        '`Phaser` is not imported in this file. Use `import * as Phaser from "phaser"` instead of a script-tag global.',
      requirePhaser:
        'Use `import * as Phaser from "phaser"` instead of `require("phaser")`.',
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzePhaserImports(context.sourceCode.ast);

    return {
      Program(program) {
        imports = analyzePhaserImports(program);
      },
      Identifier(node) {
        if (node.name !== "Phaser") {
          return;
        }

        if (isImportedPhaserBinding(node, imports)) {
          return;
        }

        if (isNonValueIdentifier(node)) {
          return;
        }

        context.report({ node, messageId: "globalPhaser" });
      },
      CallExpression(node) {
        const source = requireSource(node);

        if (source === null || !isPhaserPackageSource(source)) {
          return;
        }

        context.report({ node, messageId: "requirePhaser" });
      },
    };
  },
});
