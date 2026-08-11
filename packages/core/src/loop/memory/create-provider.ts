import { access } from "node:fs/promises";
import type { IMemoryProviderConfig } from "../../config/memory-provider.types";
import { resolveBankId, type IBankIdDeps } from "./bank-id";
import { createHttpMemoryProvider } from "./http-provider";
import { createMcpMemoryProvider, type IMcpToolCaller } from "./mcp-provider";
import type { IMemoryProvider } from "./provider.types";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

/** Read `git remote get-url origin` from `cwd`; null when git fails or empty. */
export async function readGitOriginUrl(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    if (code !== 0) {
      return null;
    }

    const url = stdout.trim();

    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export function defaultBankIdDeps(
  configuredBankId: string | undefined
): IBankIdDeps {
  return {
    configuredBankId,
    gitRemoteUrl: readGitOriginUrl,
    exists: pathExists,
  };
}

/**
 * Build a memory provider from config, or null when unset / invalid.
 * MCP kind requires a live tool caller (session MCP registry).
 */
export async function createMemoryProvider(
  cwd: string,
  config: IMemoryProviderConfig | undefined,
  mcpCaller: IMcpToolCaller | null
): Promise<IMemoryProvider | null> {
  if (config === undefined) {
    return null;
  }

  const bankId = await resolveBankId(cwd, defaultBankIdDeps(config.bankId));

  if (config.kind === "http") {
    const baseUrl = config.baseUrl.trim();

    if (baseUrl.length === 0) {
      return null;
    }

    return createHttpMemoryProvider(bankId, baseUrl);
  }

  // kind === "mcp" (only remaining variant)
  if (mcpCaller === null || config.server.trim().length === 0) {
    return null;
  }

  return createMcpMemoryProvider(bankId, config, mcpCaller);
}
