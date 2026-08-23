import { describe, expect, test } from "bun:test";
import { runPhaserBuild, type IPhaserHost } from "../src/loop/phaser/build";
import { PHASER_NO_DEV_DENY } from "../src/loop/phaser/build-config";
import type { Exec } from "../src/loop/phaser/exec";
import type { IGenerateSliceResult } from "../src/loop/phaser/generate";
import type { IWireSliceResult } from "../src/loop/phaser/wire";
import type {
  PhaserProductPlan,
  IPhaserViewIntent,
} from "../src/loop/phaser/plan-extension";
import type { ISlice } from "../src/loop/planning/plan-types";

function slice(
  id: string,
  kind: IPhaserViewIntent["kind"] = "feature"
): ISlice<IPhaserViewIntent> {
  return {
    entity: {
      id,
      desc: id,
      fields: [],
      relationships: [],
      rules: [],
    },
    ui: {
      kind,
      scene: "World",
      ...(kind === "feature" ? { feature: id.toLowerCase() } : {}),
    },
    verification: {
      mustRemainTrue: ["a"],
      mustNotHappen: ["b"],
      acceptanceCheck: "bun test",
    },
  };
}

function planOf(...ids: string[]): PhaserProductPlan {
  return {
    product: "coins",
    slices: ids.map((id) => slice(id)),
  };
}

describe("runPhaserBuild", () => {
  test("generate → setScope → setGate(check) → send; second slice waits for green", async () => {
    const log: string[] = [];
    const host: IPhaserHost = {
      setScope: (globs) => {
        log.push(`scope:${globs.join(",")}`);
      },
      setGate: (gate) => {
        log.push(`gate:${typeof gate === "string" ? gate : "runner"}`);
      },
      send: () => {
        log.push("send");

        return Promise.resolve({
          status:
            log.filter((l) => l === "send").length === 1 ? "stuck" : "done",
          turns: 1,
        });
      },
    };
    const generateCalls: string[] = [];

    const generate = (
      _cwd: string,
      s: ISlice<IPhaserViewIntent>
    ): Promise<IGenerateSliceResult> => {
      generateCalls.push(s.entity.id);

      return Promise.resolve({
        skipped: false,
        argv: ["bun", "run", "new:feature", "--", s.entity.id],
        paths: [`src/features/${s.entity.id.toLowerCase()}/X.ts`],
      });
    };

    const wire = (): Promise<IWireSliceResult> =>
      Promise.resolve({
        paths: ["src/runtime/phaser/scenes/WorldScene/WorldScene.setup.ts"],
      });

    const exec: Exec = (argv) => {
      log.push(`exec:${argv.join(" ")}`);

      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    const result = await runPhaserBuild({
      cwd: "/tmp/game",
      plan: planOf("Coin", "Gem"),
      host,
      exec,
      generate,
      wire,
    });

    expect(generateCalls).toEqual(["Coin"]);
    expect(result.status).toBe("parked");
    expect(result.parked).toBe("Coin");
    expect(log).toContain("gate:bun run check");
    expect(log.filter((l) => l === "send")).toHaveLength(1);
  });

  test("runs smoke after a green slice when asked", async () => {
    const execLog: string[] = [];
    const host: IPhaserHost = {
      setScope: () => undefined,
      setGate: () => undefined,
      send: () => Promise.resolve({ status: "done", turns: 1 }),
    };

    const exec: Exec = (argv) => {
      execLog.push(argv.join(" "));

      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };

    const result = await runPhaserBuild({
      cwd: "/tmp/game",
      plan: planOf("Coin"),
      host,
      exec,
      generate: () =>
        Promise.resolve({ skipped: true, argv: null, paths: ["a.ts"] }),
      wire: () => Promise.resolve({ paths: [] }),
      runSmoke: true,
    });

    expect(result.status).toBe("done");
    expect(execLog.some((c) => c.includes("test:smoke"))).toBe(true);
  });
});

describe("PHASER_NO_DEV_DENY", () => {
  test("denies playwright, vite, bun run dev, and bun run new:", () => {
    const deny = PHASER_NO_DEV_DENY.deny ?? [];
    const pattern = deny[0]?.commandPattern ?? "";
    const re = new RegExp(pattern, "u");

    expect(re.test("npx playwright test")).toBe(true);
    expect(re.test("bun run dev")).toBe(true);
    expect(re.test("vite")).toBe(true);
    expect(re.test("bun run new:feature -- Coin")).toBe(true);
    expect(re.test("bun run check")).toBe(false);
  });
});
