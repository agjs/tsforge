import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsforgeConfig } from "../src/config";
import { Session } from "../src/loop";
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
