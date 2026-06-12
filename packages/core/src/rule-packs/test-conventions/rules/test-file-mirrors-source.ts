import fs from "node:fs";
import path from "node:path";

import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { toPosixRelative } from "../utils/path";

export const RULE_NAME = "test-file-mirrors-source";

export interface TestFileMirrorsSourceOptions {
  readonly testRoot?: string;
  readonly sourceRoot?: string;
  readonly testSuffix?: string;
  readonly additionalSourceRoots?: readonly string[];
}

type RuleOptions = [TestFileMirrorsSourceOptions];
type MessageIds = "orphanedTest";

const DEFAULT_TEST_ROOT = "tests";
const DEFAULT_SOURCE_ROOT = "src";
const DEFAULT_TEST_SUFFIX = ".test.ts";
const DEFAULT_ADDITIONAL_SOURCE_ROOTS: readonly string[] = [];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    testRoot: { type: "string", minLength: 1 },
    sourceRoot: { type: "string", minLength: 1 },
    testSuffix: { type: "string", minLength: 1 },
    additionalSourceRoots: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
  },
};

/**
 * Indirection so test suites can stub fs lookups without spinning up a
 * real filesystem. Defaults to the real `fs.existsSync`.
 */
export type FileExistsFn = (absolutePath: string) => boolean;

let fileExists: FileExistsFn = (p) => fs.existsSync(p);

export function setFileExistsForTesting(fn: FileExistsFn | null): void {
  fileExists = fn ?? ((p) => fs.existsSync(p));
}

export const testFileMirrorsSourceRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Every test file under `tests/` must mirror a source file under `src/`. Catches orphaned tests left behind after refactors and renames.",
    },
    schema: [optionSchema],
    messages: {
      orphanedTest:
        "Test file '{{file}}' has no matching source — expected '{{expected}}'. Either rename the test or delete it.",
    },
  },
  defaultOptions: [
    {
      testRoot: DEFAULT_TEST_ROOT,
      sourceRoot: DEFAULT_SOURCE_ROOT,
      testSuffix: DEFAULT_TEST_SUFFIX,
      additionalSourceRoots: [...DEFAULT_ADDITIONAL_SOURCE_ROOTS],
    },
  ],
  create(context, [options]) {
    const testRoot = options.testRoot ?? DEFAULT_TEST_ROOT;
    const sourceRoot = options.sourceRoot ?? DEFAULT_SOURCE_ROOT;
    const testSuffix = options.testSuffix ?? DEFAULT_TEST_SUFFIX;
    const additionalSourceRoots =
      options.additionalSourceRoots ?? DEFAULT_ADDITIONAL_SOURCE_ROOTS;

    return {
      Program(program) {
        const filename = context.filename;
        const cwd = context.cwd;
        const relative = toPosixRelative(filename, cwd);

        const testRootPrefix = `${testRoot.replace(/\/$/, "")}/`;

        if (!relative.startsWith(testRootPrefix)) {
          return;
        }

        if (!relative.endsWith(testSuffix)) {
          return;
        }

        const innerPath = relative.slice(
          testRootPrefix.length,
          relative.length - testSuffix.length
        );

        const candidateRoots = [sourceRoot, ...additionalSourceRoots];
        const candidates = candidateRoots.map((root) =>
          path.resolve(cwd, `${root.replace(/\/$/, "")}/${innerPath}.ts`)
        );

        for (const candidate of candidates) {
          if (fileExists(candidate)) {
            return;
          }
        }

        const expectedRelative = `${sourceRoot.replace(/\/$/, "")}/${innerPath}.ts`;

        context.report({
          node: program,
          messageId: "orphanedTest",
          data: {
            file: relative,
            expected: expectedRelative,
          },
        });
      },
    };
  },
});
