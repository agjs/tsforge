import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveBankId,
  findProjectRoot,
  redactForRetain,
  formatDecisionBrief,
  decisionBriefBlock,
  buildDecisionRetainText,
  createHttpMemoryProvider,
  createMcpMemoryProvider,
  type IHttpMemoryFetch,
} from "../src/loop/memory";
import {
  parseMemoryProviderConfig,
  parseProviders,
} from "../src/config/providers-config";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-decmem-"));
}

describe("resolveBankId", () => {
  test("uses configured bankId when set", async () => {
    const id = await resolveBankId("/any", {
      configuredBankId: "tsforge:github.com/acme/crm",
      gitRemoteUrl: async () => "https://github.com/other/repo.git",
      exists: async () => false,
    });

    expect(id).toBe("tsforge:github.com/acme/crm");
  });

  test("normalizes https git remote", async () => {
    const id = await resolveBankId("/proj", {
      gitRemoteUrl: async () => "https://github.com/acme/crm.git",
      exists: async (p) =>
        p.endsWith(".git") || p.endsWith("tsforge.config.json"),
    });

    expect(id).toBe("tsforge:github.com/acme/crm");
  });

  test("normalizes ssh git@ remote", async () => {
    const id = await resolveBankId("/proj", {
      gitRemoteUrl: async () => "git@github.com:acme/crm.git",
      exists: async () => true,
    });

    expect(id).toBe("tsforge:github.com/acme/crm");
  });

  test("falls back to path hash when no remote", async () => {
    const dir = await tmp();

    try {
      await writeFile(join(dir, "tsforge.config.json"), "{}");
      const { access } = await import("node:fs/promises");
      const id = await resolveBankId(dir, {
        gitRemoteUrl: async () => null,
        exists: async (p) => {
          try {
            await access(p);

            return true;
          } catch {
            return false;
          }
        },
      });

      expect(id.startsWith("tsforge:path:")).toBe(true);
      expect(id.length).toBeGreaterThan("tsforge:path:".length + 8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("findProjectRoot walks up to config", async () => {
    const root = await tmp();
    const nested = join(root, "apps", "ui");

    try {
      await mkdir(nested, { recursive: true });
      await writeFile(join(root, "tsforge.config.json"), "{}");
      const { access } = await import("node:fs/promises");
      const found = await findProjectRoot(nested, async (p) => {
        try {
          await access(p);

          return true;
        } catch {
          return false;
        }
      });

      expect(found).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("redactForRetain", () => {
  test("drops api_key lines and env assignments", () => {
    const out = redactForRetain(
      [
        "Company FK is native select",
        "API_KEY=sk-secretvaluehere123456",
        "password: hunter2",
        "Keep this decision",
      ].join("\n")
    );

    expect(out).toContain("Company FK is native select");
    expect(out).toContain("Keep this decision");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("API_KEY=");
  });

  test("redacts sk- tokens inline", () => {
    const out = redactForRetain(
      "token sk-abcdefghijklmnopqrstuvwxyz012345 in text"
    );

    expect(out).toContain("[redacted]");
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });
});

describe("formatDecisionBrief", () => {
  test("returns null for empty", () => {
    expect(formatDecisionBrief(null)).toBeNull();
    expect(formatDecisionBrief("   ")).toBeNull();
  });

  test("truncates long briefs", () => {
    const long = "a".repeat(5000);
    const brief = formatDecisionBrief(long, 100);

    expect(brief === null).toBe(false);

    if (brief !== null) {
      expect(brief.length).toBeLessThanOrEqual(100);
      expect(brief.endsWith("…")).toBe(true);
    }
  });

  test("decisionBriefBlock empty when null", () => {
    expect(decisionBriefBlock(null)).toBe("");
    expect(decisionBriefBlock("use native select")).toContain(
      "Project decision memory:"
    );
  });

  test("buildDecisionRetainText skips empty summary", () => {
    expect(
      buildDecisionRetainText({ kind: "feature", summary: "  " })
    ).toBeNull();
    expect(
      buildDecisionRetainText({
        kind: "feature",
        summary: "Contacts",
        details: ["company required"],
      })
    ).toContain("Contacts");
  });
});

describe("parseMemoryProviderConfig", () => {
  test("parses http config", () => {
    const cfg = parseMemoryProviderConfig({
      kind: "http",
      baseUrl: "http://localhost:8888",
      bankId: "tsforge:github.com/acme/crm",
    });

    expect(cfg?.kind).toBe("http");

    if (cfg?.kind === "http") {
      expect(cfg.baseUrl).toBe("http://localhost:8888");
      expect(cfg.bankId).toBe("tsforge:github.com/acme/crm");
    }
  });

  test("rejects unknown kind", () => {
    expect(parseMemoryProviderConfig({ kind: "redis" })).toBeUndefined();
  });

  test("parseProviders returns memory when valid", () => {
    const providers = parseProviders({
      memory: { kind: "http", baseUrl: "http://127.0.0.1:8888" },
    });

    expect(providers?.memory?.kind).toBe("http");
  });
});

describe("createHttpMemoryProvider", () => {
  test("retain posts redacted content; recall formats results", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];

    const fetchFn: IHttpMemoryFetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });

      if (init.method === "POST" && url.includes("/recall")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              results: [{ text: "Company FK: native select" }],
            }),
        };
      }

      return { ok: true, status: 200, text: async () => "{}" };
    };

    const provider = createHttpMemoryProvider(
      "tsforge:github.com/acme/crm",
      "http://localhost:8888",
      fetchFn
    );

    await provider.retain("Company FK: native select\nAPI_KEY=secret");
    const brief = await provider.recall("decisions");

    expect(brief).toBe("Company FK: native select");
    expect(
      calls.some((c) => c.method === "POST" && c.url.includes("/memories"))
    ).toBe(true);
    const retainCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/memories")
    );

    expect(retainCall?.body).toContain("native select");
    expect(retainCall?.body).not.toContain("API_KEY=secret");
  });

  test("recall returns null when backend fails", async () => {
    const provider = createHttpMemoryProvider(
      "bank",
      "http://localhost:1",
      async () => {
        throw new Error("ECONNREFUSED");
      }
    );

    expect(await provider.recall("q")).toBeNull();
  });

  test("forget and list are fail-soft", async () => {
    const provider = createHttpMemoryProvider(
      "bank",
      "http://localhost:1",
      async () => {
        throw new Error("down");
      }
    );

    await provider.forget();
    expect(await provider.list()).toEqual([]);
  });
});

describe("createMcpMemoryProvider", () => {
  test("calls namespaced tools with bank_id", async () => {
    const seen: { name: string; args: Record<string, unknown> }[] = [];
    const provider = createMcpMemoryProvider(
      "tsforge:path:abc",
      { kind: "mcp", server: "hindsight" },
      {
        callTool: async (name, args) => {
          seen.push({ name, args });

          if (name.includes("recall")) {
            return JSON.stringify({ text: "prior decision" });
          }

          return "ok";
        },
      }
    );

    expect(await provider.recall("q")).toBe("prior decision");
    await provider.retain("new decision");
    expect(seen[0]?.name).toContain("hindsight");
    expect(seen[0]?.args.bank_id).toBe("tsforge:path:abc");
  });
});
