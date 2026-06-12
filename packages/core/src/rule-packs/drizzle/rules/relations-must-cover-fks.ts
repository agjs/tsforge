import fs from "node:fs";
import path from "node:path";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  findCallExpressionsDeep,
  isForeignKeyCall,
  isPgTableCall,
  isRelationsCall,
} from "../utils";

export const RULE_NAME = "relations-must-cover-fks";

export interface RelationsMustCoverFksOptions {
  readonly allowExternalFile?: boolean;
  readonly relationsFilePatterns?: readonly string[];
}

type RuleOptions = [RelationsMustCoverFksOptions];
type MessageIds = "missingRelations";

const DEFAULT_RELATIONS_FILES: readonly string[] = [
  "relations.ts",
  "relations.tsx",
  "relations.js",
];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowExternalFile: {
      type: "boolean",
    },
    relationsFilePatterns: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

interface IRelationsFileCache {
  readonly mtimeMs: number;
  readonly tables: ReadonlySet<string>;
}

const relationsFileCache = new Map<string, IRelationsFileCache>();
const RELATIONS_CALL_PATTERN = /\brelations\s*\(\s*([A-Za-z_$][\w$]*)/g;

function readTablesFromRelationsFile(filePath: string): ReadonlySet<string> {
  let stat: fs.Stats;

  try {
    stat = fs.statSync(filePath);
  } catch {
    return new Set();
  }

  const cached = relationsFileCache.get(filePath);

  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.tables;
  }

  let source: string;

  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return new Set();
  }

  const tables = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = RELATIONS_CALL_PATTERN.exec(source)) !== null) {
    if (match[1]) {
      tables.add(match[1]);
    }
  }

  RELATIONS_CALL_PATTERN.lastIndex = 0;

  relationsFileCache.set(filePath, { mtimeMs: stat.mtimeMs, tables });

  return tables;
}

function collectExternalRelations(
  startDir: string,
  patterns: readonly string[]
): Set<string> {
  const out = new Set<string>();
  const cwd = process.cwd();
  let cursor = path.resolve(startDir);

  while (true) {
    for (const basename of patterns) {
      const candidate = path.join(cursor, basename);

      if (fs.existsSync(candidate)) {
        for (const t of readTablesFromRelationsFile(candidate)) {
          out.add(t);
        }
      }
    }

    if (cursor === cwd || path.dirname(cursor) === cursor) {
      break;
    }

    cursor = path.dirname(cursor);
  }

  return out;
}

export const relationsMustCoverFksRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Every Drizzle table that declares a foreignKey(...) must be covered by a relations(...) call. Searches sibling `relations.ts` files by default.",
    },
    schema: [optionSchema],
    messages: {
      missingRelations:
        "Table '{{name}}' declares foreignKey(...) but no relations(...) call covers it. Drizzle's `db.query.{{name}}.findMany({ with: ... })` will not work.",
    },
  },
  defaultOptions: [{ allowExternalFile: true }],
  create(context, [options]) {
    const allowExternalFile = options.allowExternalFile ?? true;
    const relationsFiles =
      options.relationsFilePatterns ?? DEFAULT_RELATIONS_FILES;

    const tablesWithFks = new Map<string, TSESTree.VariableDeclarator>();
    const tablesWithRelations = new Set<string>();

    return {
      VariableDeclarator(node) {
        if (!node.init || node.init.type !== AST_NODE_TYPES.CallExpression) {
          return;
        }

        if (!isPgTableCall(node.init)) {
          return;
        }

        if (node.id.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        const fkCalls = findCallExpressionsDeep(node.init, isForeignKeyCall);

        if (fkCalls.length === 0) {
          return;
        }

        tablesWithFks.set(node.id.name, node);
      },
      CallExpression(node) {
        if (!isRelationsCall(node)) {
          return;
        }

        const firstArg = node.arguments[0];

        if (firstArg && firstArg.type === AST_NODE_TYPES.Identifier) {
          tablesWithRelations.add(firstArg.name);
        }
      },
      "Program:exit"() {
        if (allowExternalFile) {
          const filename = context.filename;

          if (filename && filename !== "<input>") {
            const dir = path.dirname(filename);

            for (const t of collectExternalRelations(dir, relationsFiles)) {
              tablesWithRelations.add(t);
            }
          }
        }

        for (const [name, declarator] of tablesWithFks) {
          if (tablesWithRelations.has(name)) {
            continue;
          }

          context.report({
            node: declarator,
            messageId: "missingRelations",
            data: { name },
          });
        }
      },
    };
  },
});

export function __clearRelationsFileCacheForTests(): void {
  relationsFileCache.clear();
}
