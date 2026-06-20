import { join } from "node:path";
import { isRecord } from "../lib/guards";
import { writeFilesOrRollback, type IWriteFile } from "../lib/fs/fs";
import type { IScanReport } from "../infer-rules/scan.types";
import type { ISetupConfig, IWriteResult } from "./setup.types";

const CONFIG_FILE = "tsforge.config.json";
const EVIDENCE_FILE = ".tsforge/setup-evidence.json";

/** Merge the setup-managed fields onto an existing config object, PRESERVING every
 *  other key (mcpServers, plugins, policy, rules, stack, and any unknown keys).
 *  User-selected setup fields win. Pure — no IO. */
export function mergeSetupConfig(
  existing: Readonly<Record<string, unknown>>,
  setup: ISetupConfig
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };

  if (setup.profile !== undefined) {
    out.profile = setup.profile;
  }

  if (setup.packs !== undefined) {
    out.packs = setup.packs;
  }

  if (setup.conventions !== undefined) {
    out.conventions = setup.conventions;
  }

  return out;
}

/** Parse the existing config text, or signal that it's unparseable. */
function parseExisting(
  text: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(text);

    if (!isRecord(parsed)) {
      return { ok: false, error: "config root is not an object" };
    }

    return { ok: true, value: parsed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write the wizard's choices into tsforge.config.json (merged, preserving unrelated
 * fields) and the scan evidence into .tsforge/setup-evidence.json — ATOMICALLY (both
 * land or neither, via writeFilesOrRollback). If the existing config is invalid JSON,
 * refuse unless `overwriteInvalid` is set, so the caller can ask the user first.
 * Runtime reads the CONFIG, never the evidence (which is audit/debug only).
 */
export async function writeSetupConfig(
  cwd: string,
  setup: ISetupConfig,
  report: IScanReport | undefined,
  opts: { overwriteInvalid?: boolean } = {}
): Promise<IWriteResult> {
  const configHandle = Bun.file(join(cwd, CONFIG_FILE));
  let existing: Record<string, unknown> = {};

  if (await configHandle.exists()) {
    const parsed = parseExisting(await configHandle.text());

    if (!parsed.ok) {
      if (opts.overwriteInvalid !== true) {
        return {
          ok: false,
          reason: "invalid-existing-json",
          error: parsed.error,
        };
      }
    } else {
      existing = parsed.value;
    }
  }

  const merged = mergeSetupConfig(existing, setup);
  const files: IWriteFile[] = [
    { path: CONFIG_FILE, content: serialize(merged) },
  ];

  if (report !== undefined) {
    files.push({ path: EVIDENCE_FILE, content: serialize(report) });
  }

  const result = await writeFilesOrRollback(cwd, files);

  if (!result.ok) {
    return { ok: false, reason: "write-failed", error: result.reason };
  }

  return {
    ok: true,
    path: CONFIG_FILE,
    ...(report === undefined ? {} : { evidencePath: EVIDENCE_FILE }),
  };
}
