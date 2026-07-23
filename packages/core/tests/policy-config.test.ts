import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsforgeConfig } from "../src/config";
import { Session } from "../src/loop";
import { mergePolicyRules } from "../src/policy";
import type { IPolicyRules } from "../src/policy";
import type { IProvider } from "../src/inference";

async function withConfig<T>(
  config: unknown,
  fn: (dir: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-polcfg-"));

  await writeFile(join(dir, "tsforge.config.json"), JSON.stringify(config));

  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A provider that fires one `create` tool call, then stops. */
function createOnce(results: string[]): IProvider {
  let calls = 0;

  return {
    async complete(messages) {
      calls += 1;
      results.length = 0;
      results.push(
        ...messages.filter((m) => m.role === "tool").map((m) => m.content)
      );

      if (calls === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "1",
              name: "create",
              arguments: { file: "x.ts", content: "x" },
            },
          ],
        };
      }

      return { content: "ok", toolCalls: [] };
    },
  };
}

describe("policy config parsing (warn-and-drop)", () => {
  test("parses a valid policy block", async () => {
    await withConfig(
      {
        policy: {
          mode: "ci",
          rules: {
            deny: [{ kind: "network" }],
            allow: [{ commandPrefix: "bun test" }],
          },
        },
      },
      async (dir) => {
        const cfg = await loadTsforgeConfig(dir);

        expect(cfg.policy?.mode).toBe("ci");
        expect(cfg.policy?.rules?.deny?.[0]?.kind).toBe("network");
        expect(cfg.policy?.rules?.allow?.[0]?.commandPrefix).toBe("bun test");
      }
    );
  });

  test("drops an invalid mode and a non-object policy", async () => {
    await withConfig({ policy: { mode: "yolo" } }, async (dir) => {
      expect((await loadTsforgeConfig(dir)).policy?.mode).toBeUndefined();
    });
    await withConfig({ policy: "nope" }, async (dir) => {
      expect((await loadTsforgeConfig(dir)).policy).toBeUndefined();
    });
  });

  test("drops a non-ActionKind rule kind but keeps valid string fields", async () => {
    await withConfig(
      { policy: { rules: { deny: [{ kind: "bogus", toolName: "run" }] } } },
      async (dir) => {
        const rule = (await loadTsforgeConfig(dir)).policy?.rules?.deny?.[0];

        expect(rule?.kind).toBeUndefined();
        expect(rule?.toolName).toBe("run");
      }
    );
  });

  test("a rule whose ONLY fields are invalid is dropped, not turned into a catch-all", async () => {
    // `{ kind: "shel" }` is a typo: the invalid field is dropped, leaving `{}` —
    // which the policy treats as match-EVERYTHING. That would silently turn a
    // typo'd deny into a GLOBAL deny (or allow). It must be dropped instead.
    await withConfig(
      { policy: { rules: { deny: [{ kind: "shel" }] } } },
      async (dir) => {
        const deny = (await loadTsforgeConfig(dir)).policy?.rules?.deny ?? [];

        expect(deny).toHaveLength(0);
      }
    );
  });

  test("a literal empty rule {} is preserved as an intentional catch-all", async () => {
    await withConfig({ policy: { rules: { deny: [{}] } } }, async (dir) => {
      const deny = (await loadTsforgeConfig(dir)).policy?.rules?.deny ?? [];

      expect(deny).toHaveLength(1);
      expect(Object.keys(deny[0] ?? {})).toHaveLength(0);
    });
  });
});

describe("policy config → session enforcement", () => {
  test("config policy.mode 'plan' denies a write end-to-end", async () => {
    await withConfig({ policy: { mode: "plan" } }, async (dir) => {
      const results: string[] = [];
      const session = await Session.create({
        provider: createOnce(results),
        cwd: dir,
        files: ["**/*"],
      });

      await session.send("write it");

      expect(results.some((t) => t.includes("policy deny"))).toBe(true);
      expect(existsSync(join(dir, "x.ts"))).toBe(false);
    });
  });

  test("--policy-mode default overrides config 'plan' (CLI wins)", async () => {
    await withConfig({ policy: { mode: "plan" } }, async (dir) => {
      const results: string[] = [];
      const session = await Session.create({
        provider: createOnce(results),
        cwd: dir,
        files: ["**/*"],
        policyMode: "default",
      });

      await session.send("write it");

      expect(existsSync(join(dir, "x.ts"))).toBe(true);
    });
  });
});

describe("mergePolicyRules", () => {
  test("returns the other set when one is undefined (no-rules fast path preserved)", () => {
    const rules: IPolicyRules = { deny: [{ toolName: "read" }] };

    expect(mergePolicyRules(undefined, undefined)).toBeUndefined();
    expect(mergePolicyRules(rules, undefined)).toBe(rules);
    expect(mergePolicyRules(undefined, rules)).toBe(rules);
  });

  test("APPENDS each list so an injected deny is added on top of config rules", () => {
    const base: IPolicyRules = {
      deny: [{ toolName: "read" }],
      allow: [{ toolName: "edit" }],
    };
    const extra: IPolicyRules = {
      deny: [{ kind: "shell", commandPattern: "playwright" }],
    };
    const merged = mergePolicyRules(base, extra);

    expect(merged?.deny).toHaveLength(2);
    expect(merged?.deny?.[0]).toEqual({ toolName: "read" });
    expect(merged?.deny?.[1]).toEqual({
      kind: "shell",
      commandPattern: "playwright",
    });
    // config's allow is preserved; ask stays absent (empty lists omitted).
    expect(merged?.allow).toHaveLength(1);
    expect(merged?.ask).toBeUndefined();
  });
});
