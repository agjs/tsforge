import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards";

/**
 * Read the recorded archetype from a project's `.tsforge/scaffold.json`, or null
 * if absent/unreadable/malformed. Shared by stack adapters so detection keys on
 * the same receipt file. `read` is injectable for tests.
 */
export async function readScaffoldArchetype(
  dir: string,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf-8")
): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(
      await read(join(dir, ".tsforge", "scaffold.json"))
    );

    return isRecord(raw) && typeof raw.archetype === "string"
      ? raw.archetype
      : null;
  } catch {
    return null;
  }
}
