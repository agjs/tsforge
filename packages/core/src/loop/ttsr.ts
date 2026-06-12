import { isArray, isRecord } from "../lib/guards";

/**
 * A TTSR rule — triggers on matching stream text, aborts generation, and injects
 * corrective guidance on retry. Rules watch specific channels (prose vs tool args)
 * and optionally scope to files matching a glob.
 */
export interface ITtsrRule {
  readonly name: string;
  /** Regex patterns (as source strings for JSON, or RegExp objects for code).
   *  Compiled once at manager init. Each is OR'd; any match fires. */
  readonly condition: readonly (string | RegExp)[];
  /** Which stream channel(s) to monitor: "content" (prose), "tool-args" (tool call
   *  arguments being assembled), or "both". */
  readonly scope: "content" | "tool-args" | "both";
  /** Optional file globs: for tool-args scope, only match when the edit/create
   *  targets a file path matching one of these globs. */
  readonly fileGlobs?: readonly string[];
  /** Guidance text (≤300 chars) appended to the corrective message on retry. */
  readonly guidance: string;
  /** "once" = fires at most once per session; "cooldown" = re-arms after repeatGap
   *  turns without a match. */
  readonly repeatMode: "once" | "cooldown";
  /** Gap (in completed turns) before a "cooldown"-mode rule can re-fire. */
  readonly repeatGap?: number;
}

/** Match context: information about the stream being monitored. */
export interface IMatchContext {
  source: "content" | "tool-args";
  /** Current file being edited/created (when tool-args scope), if available. */
  currentFile?: string;
}

/**
 * Manages TTSR rule matching and firing. Keeps a rolling buffer per scope/channel
 * to catch patterns spanning chunk boundaries; respects repeat policy + scope gates.
 */
export class TtsrManager {
  private readonly rules: Map<string, ITtsrRule> = new Map<string, ITtsrRule>();
  private readonly compiledConditions: Map<string, RegExp[]> = new Map<
    string,
    RegExp[]
  >();
  private buffers: Record<"content" | "tool-args", string> = {
    content: "",
    "tool-args": "",
  };
  private readonly turnCounts: Map<string, number> = new Map<string, number>();
  private messageCount = 0;

  /** Max chars to retain in rolling buffer (patterns spanning ~10 chunks). */
  private readonly BUFFER_SIZE = 512;

  /**
   * Register a rule. Validates regex conditions; skips invalid or duplicate rules.
   * Returns true if registered, false if skipped.
   */
  addRule(rule: ITtsrRule): boolean {
    if (this.rules.has(rule.name)) {
      return false;
    }

    const compiled: RegExp[] = [];

    for (const pattern of rule.condition) {
      try {
        if (pattern instanceof RegExp) {
          compiled.push(pattern);
        } else {
          compiled.push(new RegExp(pattern));
        }
      } catch {
        // Invalid regex — skip this rule entirely.
        return false;
      }
    }

    if (compiled.length === 0) {
      return false;
    }

    this.rules.set(rule.name, rule);
    this.compiledConditions.set(rule.name, compiled);

    return true;
  }

  /** Feed a delta into the rolling buffer and check all rules. Returns the first
   *  matching rule or null. Accumulates text into buffers per source channel. */
  checkDelta(text: string, context: IMatchContext): ITtsrRule | null {
    const bufferKey = context.source;

    this.buffers[bufferKey] += text;

    // Trim buffer to max size, keeping the tail (so patterns spanning boundaries match).
    if (this.buffers[bufferKey].length > this.BUFFER_SIZE) {
      this.buffers[bufferKey] = this.buffers[bufferKey].slice(
        -this.BUFFER_SIZE
      );
    }

    const buf = this.buffers[bufferKey];

    // Check all rules; return first match that passes repeat policy and scope gates.
    for (const [ruleName, rule] of this.rules) {
      if (!this.isScopeActive(rule, context)) {
        continue;
      }

      if (!this.isRepeatEligible(ruleName, rule)) {
        continue;
      }

      if (this.doesMatch(ruleName, buf)) {
        return rule;
      }
    }

    return null;
  }

  /** Mark a rule as fired at the current turn (for repeat policy tracking). */
  markFired(ruleName: string, turn: number): void {
    this.turnCounts.set(ruleName, turn);
  }

  /** Increment message count (call on turn_end for cooldown gap accounting). */
  incrementTurnCount(): void {
    this.messageCount += 1;
  }

  /** Reset the rolling buffers (call on turn start so each turn's patterns start fresh). */
  resetBuffer(): void {
    this.buffers.content = "";
    this.buffers["tool-args"] = "";
  }

  /** Check if a rule's scope includes the current source. */
  private isScopeActive(rule: ITtsrRule, context: IMatchContext): boolean {
    if (rule.scope === "both") {
      return true;
    }

    return rule.scope === context.source;
  }

  /** Check if a rule is eligible to fire based on repeat policy. */
  private isRepeatEligible(ruleName: string, rule: ITtsrRule): boolean {
    const lastFired = this.turnCounts.get(ruleName);

    if (lastFired === undefined) {
      return true; // Never fired before.
    }

    if (rule.repeatMode === "once") {
      return false; // Fired once, never again.
    }

    const gap = rule.repeatGap ?? 1;

    return this.messageCount - lastFired >= gap;
  }

  /** Check if any regex condition matches the buffer. */
  private doesMatch(ruleName: string, buf: string): boolean {
    const conditions = this.compiledConditions.get(ruleName);

    if (!conditions) {
      return false;
    }

    return conditions.some((re) => re.test(buf));
  }
}

/** Extract scope from parsed item, validating the value. */
function extractScope(scopeValue: unknown): "content" | "tool-args" | "both" {
  if (
    scopeValue === "tool-args" ||
    scopeValue === "content" ||
    scopeValue === "both"
  ) {
    return scopeValue;
  }

  return "content";
}

/** Extract conditions (regex patterns) from parsed item. */
function extractConditions(conditionValue: unknown): string[] {
  if (isArray(conditionValue)) {
    return conditionValue.filter((x) => typeof x === "string");
  }

  if (typeof conditionValue === "string") {
    return [conditionValue];
  }

  return [];
}

/** Extract optional file globs from parsed item. */
function extractFileGlobs(fileGlobsValue: unknown): string[] | undefined {
  if (!isArray(fileGlobsValue)) {
    return undefined;
  }

  const globs = fileGlobsValue.filter((x) => typeof x === "string");

  return globs.length > 0 ? globs : undefined;
}

/** Parse .tsforge/rules.json (optional project rules). */
export function parseProjectRules(content: string): ITtsrRule[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  if (!isArray(parsed)) {
    return [];
  }

  const rules: ITtsrRule[] = [];

  for (const item of parsed) {
    if (!isRecord(item) || typeof item.name !== "string") {
      continue;
    }

    const condition = extractConditions(item.condition);
    const guidance = typeof item.guidance === "string" ? item.guidance : "";

    if (condition.length === 0 || guidance.length === 0) {
      continue;
    }

    const scope = extractScope(item.scope);
    const repeatMode = item.repeatMode === "cooldown" ? "cooldown" : "once";
    const repeatGap =
      typeof item.repeatGap === "number" && item.repeatGap >= 0
        ? Math.floor(item.repeatGap)
        : undefined;
    const fileGlobs = extractFileGlobs(item.fileGlobs);

    const rule = createRule(
      item.name,
      condition,
      scope,
      guidance,
      repeatMode,
      repeatGap,
      fileGlobs
    );

    rules.push(rule);
  }

  return rules;
}

/** Create a rule from parsed/validated components. */
function createRule(
  name: string,
  condition: readonly (string | RegExp)[],
  scope: "content" | "tool-args" | "both",
  guidance: string,
  repeatMode: "once" | "cooldown",
  repeatGap: number | undefined,
  fileGlobs: string[] | undefined
): ITtsrRule {
  return {
    name,
    condition,
    scope,
    guidance,
    repeatMode,
    ...(fileGlobs && fileGlobs.length > 0 ? { fileGlobs } : {}),
    ...(repeatGap !== undefined && repeatGap > 0 ? { repeatGap } : {}),
  } as ITtsrRule;
}
