import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { existsSync } from "fs";
import { dirname, join } from "path";

import { createRule } from "../../create-rule";

export const RULE_NAME = "index-must-reexport-default";

type RuleOptions = [];
type MessageIds = "mustReexport" | "unexpectedStatement";

const isIndexFile = (filename: string): boolean => {
  const basename = filename.split("/").pop();

  return basename === "index.ts" || basename === "index.tsx";
};

const getParentComponentName = (filename: string): string | null => {
  const dir = dirname(filename);
  const basename = dir.split("/").pop();

  if (!basename || !/^[A-Z]/.test(basename)) {
    return null;
  }

  return basename;
};

const componentFileExists = (dir: string, name: string): boolean => {
  return existsSync(join(dir, `${name}.tsx`));
};

export const indexMustReexportDefaultRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description:
          "index.ts in component folders must re-export the component default export and types",
      },
      schema: [],
      messages: {
        mustReexport:
          'index.ts must contain re-export: export {{ default as {{name}} }} from "./{{name}}";',
        unexpectedStatement:
          "Unexpected statement in index.ts - only re-exports are allowed",
      },
    },
    defaultOptions: [],
    create(context) {
      const filename = context.filename;

      if (!isIndexFile(filename)) {
        return {};
      }

      const componentName = getParentComponentName(filename);

      if (!componentName) {
        return {};
      }

      const dir = dirname(filename);

      if (!componentFileExists(dir, componentName)) {
        return {};
      }

      return {
        "Program:exit"(program) {
          let foundDefaultExport = false;

          for (const stmt of program.body) {
            if (
              stmt.type === AST_NODE_TYPES.ExportNamedDeclaration &&
              stmt.declaration === null
            ) {
              // Check for default re-export
              if (stmt.specifiers.length > 0) {
                const spec = stmt.specifiers[0];

                if (
                  spec?.type === AST_NODE_TYPES.ExportSpecifier &&
                  spec.exported?.type === AST_NODE_TYPES.Identifier &&
                  spec.exported.name === componentName &&
                  spec.local?.type === AST_NODE_TYPES.Identifier &&
                  spec.local.name === "default"
                ) {
                  foundDefaultExport = true;
                }
              }

              // Type re-exports are OK too
              continue;
            }

            if (stmt.type === AST_NODE_TYPES.ExportAllDeclaration) {
              // Type re-exports like export * from "./<Name>.types"
              continue;
            }

            // Any other statement is not allowed
            if (stmt.type !== AST_NODE_TYPES.ExportNamedDeclaration) {
              context.report({
                node: stmt,
                messageId: "unexpectedStatement",
              });
            }
          }

          if (!foundDefaultExport) {
            context.report({
              node: program,
              messageId: "mustReexport",
              data: { name: componentName },
            });
          }
        },
      };
    },
  }
);
