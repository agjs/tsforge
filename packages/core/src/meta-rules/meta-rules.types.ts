/**
 * Meta-rules: project structure & config guardrails that ESLint cannot express.
 * Categories align with risk domains: supply-chain (deps), config (tsconfig/eslint),
 * source-text (inline suppressions), testing (coverage), stack-layout (dirs),
 * and ci (workflows).
 */
export type MetaRuleCategory =
  | "supply-chain"
  | "config"
  | "source-text"
  | "testing"
  | "stack-layout"
  | "ci"
  | "container";

/** A single rule violation (file, rule, message). */
export interface IMetaRuleViolation {
  readonly file: string; // repo-relative path
  readonly ruleId: string;
  readonly severity: "error" | "warn";
  readonly message: string;
}

/**
 * Context for a rule run: the project root, parsed package.json, file lists,
 * active packs from stack detection, and a cached file reader.
 */
export interface IMetaRuleContext {
  readonly root: string;
  readonly packageJson: Record<string, unknown> | null;
  readonly sourceFiles: readonly string[]; // repo-relative .ts/.tsx
  readonly changedFiles: readonly string[]; // repo-relative files changed vs git HEAD (empty when not a git repo)
  readonly configFiles: readonly string[]; // tsconfig*, eslint*, package.json, *.config.*
  readonly workflowFiles: readonly string[]; // .github/workflows/*.yml|yaml
  readonly dockerfiles: readonly string[]; // Dockerfile, Dockerfile.*, *.Dockerfile (root + 1 level)
  readonly activePacks: readonly string[]; // pack ids from stack detection
  readonly readFile: (relPath: string) => string | null; // cached, safe
}

/** A single meta-rule that checks project invariants. */
export interface IMetaRule {
  readonly id: string;
  readonly category: MetaRuleCategory;
  readonly description: string;
  /** Pack IDs this rule applies to; undefined = always applies. */
  readonly appliesTo?: readonly string[];
  readonly severity: "error" | "warn";
  /** Synchronous rule run. */
  readonly run: (ctx: IMetaRuleContext) => IMetaRuleViolation[];
}
