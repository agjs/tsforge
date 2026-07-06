/**
 * Loader for declarative agent specs — `.tsforge/agents/*.json` (project) and
 * `~/.tsforge/agents/*.json` (global); a project spec overrides a global one
 * with the same id. Mirrors config/recipes.ts: data-only, warn-and-drop
 * validation, unrecognized keys reported so a typo never silently does less.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../lib/guards";
import type {
  AgentKind,
  AgentOutputMode,
  IAgentSpec,
} from "../agent/agent-spec";

type Mutable = { -readonly [K in keyof IAgentSpec]: IAgentSpec[K] };

function optString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function optKind(value: unknown): AgentKind | undefined {
  return value === "chat" || value === "generate" ? value : undefined;
}

function optOutputMode(value: unknown): AgentOutputMode | undefined {
  return value === "text" || value === "structured" ? value : undefined;
}

function optPositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  return strings.length > 0 ? strings : undefined;
}

const KNOWN_KEYS = new Set<string>([
  "id",
  "description",
  "model",
  "kind",
  "systemPrompt",
  "tools",
  "task",
  "maxTurns",
  "outputMode",
]);

/** Keys present in the raw spec that this version doesn't recognize. */
export function unrecognizedAgentKeys(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  return Object.keys(value).filter((key) => !KNOWN_KEYS.has(key));
}

/** Validate one parsed JSON value into an IAgentSpec, or null when it isn't
 *  one. Wrong-typed fields drop (warn-and-drop happens at load); a malformed
 *  spec degrades to "ignored", never a crash. */
export function parseAgentSpec(value: unknown): IAgentSpec | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = optString(value.id);

  if (id === undefined || !/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    return null;
  }

  const spec: Mutable = { id };

  spec.description = optString(value.description);
  spec.model = optString(value.model);
  spec.kind = optKind(value.kind);
  spec.systemPrompt = optString(value.systemPrompt);
  spec.tools = stringArray(value.tools);
  spec.task = optString(value.task);
  spec.maxTurns = optPositive(value.maxTurns);
  spec.outputMode = optOutputMode(value.outputMode);

  return spec;
}

async function loadDir(
  dir: string,
  into: Map<string, IAgentSpec>,
  report: (message: string) => void
): Promise<void> {
  let names: string[];

  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return; // no directory = no specs, not an error
  }

  for (const name of names) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      report(`agent '${name}': not valid JSON — skipped`);
      continue;
    }

    const spec = parseAgentSpec(parsed);

    if (spec === null) {
      report(
        `agent '${name}': not a valid spec (needs a kebab-case id) — skipped`
      );
      continue;
    }

    const unknown = unrecognizedAgentKeys(parsed);

    if (unknown.length > 0) {
      report(
        `agent '${name}': ignoring unrecognized field(s): ${unknown.join(", ")}`
      );
    }

    into.set(spec.id, spec); // later dir (project) wins on id collision
  }
}

function homeBase(): string {
  return process.env.TSFORGE_HOME ?? homedir();
}

/** Discover all agent specs for a repo, project overriding global on id
 *  collision. Never throws — a broken spec can't take down a run. */
export async function loadAgentSpecs(
  cwd: string,
  report: (message: string) => void = () => undefined
): Promise<IAgentSpec[]> {
  const byId = new Map<string, IAgentSpec>();

  await loadDir(join(homeBase(), ".tsforge", "agents"), byId, report);
  await loadDir(join(cwd, ".tsforge", "agents"), byId, report);

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Find one spec by id. */
export function findAgentSpec(
  specs: readonly IAgentSpec[],
  id: string
): IAgentSpec | undefined {
  return specs.find((s) => s.id === id);
}
