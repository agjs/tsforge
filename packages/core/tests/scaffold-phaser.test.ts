import { describe, expect, test } from "bun:test";
import { gateCommand, runScaffold } from "../src/scaffold/run-scaffold";
import { loadPhaserTemplate } from "../src/scaffold/phaser-manifest";
import { parseManifest } from "../src/scaffold/boringstack-manifest";
import { parseScaffoldArgs } from "../src/scaffold/scaffold-cli";
import { phaserPackageName } from "../src/scaffold/apply-phaser";
import { loadScaffoldSource } from "../src/scaffold/scaffold-source";
import type {
  IScaffoldFs,
  IReadyPoller,
  IScaffoldRunner,
} from "../src/scaffold/io";
import type { IShellRun } from "../src/lib/fs/process";

const DEST = "/tmp/my-game";
const SHA = "c643a0edeadbeef00000000000000000000beef0";
const pollUp: IReadyPoller = () => Promise.resolve(200);

function memFs(seed: Record<string, string> = {}): {
  fs: IScaffoldFs;
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(seed));
  const fs: IScaffoldFs = {
    exists: (p) => Promise.resolve(store.has(p)),
    readText: (p) => Promise.resolve(store.get(p) ?? ""),
    writeText: (p, c) => {
      store.set(p, c);

      return Promise.resolve();
    },
    copy: (from, to) => {
      store.set(to, store.get(from) ?? "");

      return Promise.resolve();
    },
    remove: (p) => {
      for (const key of store.keys()) {
        if (key === p || key.startsWith(`${p}/`)) {
          store.delete(key);
        }
      }

      return Promise.resolve();
    },
  };

  return { fs, store };
}

function recordingRunner(): {
  run: IScaffoldRunner;
  calls: string[][];
} {
  const calls: string[][] = [];

  const run: IScaffoldRunner = (_cwd, argv) => {
    calls.push([...argv]);

    return Promise.resolve<IShellRun>({
      stdout: argv[1] === "rev-parse" ? `${SHA}\n` : "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  };

  return { run, calls };
}

describe("parseManifest — Phaser clone-only descriptor", () => {
  test("parses a phaser-only archetypes map (no astro/boringstack keys)", () => {
    const m = loadPhaserTemplate();

    expect(m.repo).toContain("Phaser-TypeScript-AI-First-Starter");
    expect(m.archetypes.phaser?.gates[0]?.command).toBe("bun run check");
    expect(m.archetypes.boringstack).toBeUndefined();
    expect(m.fields).toEqual([]);
  });

  test("rejects an unknown archetype key", () => {
    expect(() =>
      parseManifest({
        manifestVersion: 1,
        defaultRef: "main",
        repo: "https://example.com/x.git",
        renameParams: [],
        alwaysOnServices: [],
        fields: [],
        archetypes: {
          rails: { gates: [{ cwd: ".", command: "true" }] },
        },
      })
    ).toThrow(/unknown archetype/iu);
  });
});

describe("parseScaffoldArgs — phaser", () => {
  test("accepts --archetype phaser", () => {
    const opts = parseScaffoldArgs([
      "--archetype",
      "phaser",
      "--dest",
      "/tmp/g",
    ]);

    expect(opts.answers.archetype).toBe("phaser");
  });
});

describe("loadScaffoldSource — phaser", () => {
  test("returns the Phaser repo, not boringstack", () => {
    const m = loadScaffoldSource("phaser");

    expect(m.repo).toContain("Phaser-TypeScript-AI-First-Starter");
    expect(m.defaultRef).toMatch(/^v\d/u);
  });

  test("PHASER_TEMPLATE_REPO overrides the clone URL", () => {
    const prev = process.env.PHASER_TEMPLATE_REPO;

    process.env.PHASER_TEMPLATE_REPO = "/tmp/local-phaser";

    try {
      expect(loadScaffoldSource("phaser").repo).toBe("/tmp/local-phaser");
    } finally {
      if (prev === undefined) {
        delete process.env.PHASER_TEMPLATE_REPO;
      } else {
        process.env.PHASER_TEMPLATE_REPO = prev;
      }
    }
  });
});

describe("phaserPackageName", () => {
  test("lowercases and sanitizes", () => {
    expect(phaserPackageName("My Game")).toBe("my-game");
    expect(phaserPackageName("coin-dash")).toBe("coin-dash");
  });
});

describe("runScaffold — phaser", () => {
  test("clones the Phaser repo, writes a phaser receipt, stamps identity, does not boot", async () => {
    const { fs, store } = memFs({
      [`${DEST}/package.json`]: JSON.stringify({
        name: "phaser-ts-starter",
        version: "0.1.6",
      }),
      [`${DEST}/index.html`]:
        "<html><head><title>Phaser TS Starter</title></head></html>\n",
    });
    const { run, calls } = recordingRunner();
    const phases: string[] = [];

    const outcome = await runScaffold(
      loadPhaserTemplate(),
      { archetype: "phaser", stack: "dev", values: {} },
      DEST,
      {
        run,
        fs,
        boot: { poll: pollUp },
        onPhase: (m) => phases.push(m),
      }
    );

    const clone = calls.find((c) => c[0] === "git" && c[1] === "clone");

    expect(clone?.join(" ")).toContain("Phaser-TypeScript-AI-First-Starter");
    expect(clone?.join(" ")).not.toContain("boringstack.git");
    expect(outcome.booted).toBe(false);
    expect(outcome.gateCommand).toBe("bun run check");
    expect(outcome.summary).toEqual([]);
    expect(phases.some((p) => p.includes("Starting services"))).toBe(false);

    const record = JSON.parse(
      store.get(`${DEST}/.tsforge/scaffold.json`) ?? "{}"
    ) as { archetype?: string };

    expect(record.archetype).toBe("phaser");

    const pkg = JSON.parse(store.get(`${DEST}/package.json`) ?? "{}") as {
      name?: string;
    };

    expect(pkg.name).toBe("my-game");
    expect(store.get(`${DEST}/index.html`)).toContain("<title>my-game</title>");
    expect(calls.some((c) => c.join(" ") === "bun run catalog")).toBe(true);
  });

  test("does not run catalog when docs/ai/catalog.md is already in the clone", async () => {
    const { fs } = memFs({
      [`${DEST}/package.json`]: JSON.stringify({ name: "phaser-ts-starter" }),
      [`${DEST}/index.html`]:
        "<html><head><title>Phaser TS Starter</title></head></html>\n",
      [`${DEST}/docs/ai/catalog.md`]: "# Codebase Catalog\n",
    });
    const { run, calls } = recordingRunner();

    await runScaffold(
      loadPhaserTemplate(),
      { archetype: "phaser", stack: "dev", values: {} },
      DEST,
      { run, fs, boot: { poll: pollUp } }
    );

    expect(calls.some((c) => c.join(" ") === "bun run catalog")).toBe(false);
  });

  test("refuses a Phaser archetype against a BoringStack-only manifest", async () => {
    const { fs } = memFs();
    const { run } = recordingRunner();
    const boring = parseManifest({
      manifestVersion: 1,
      defaultRef: "main",
      repo: "https://github.com/boringstack-xyz/boringstack",
      renameParams: [],
      alwaysOnServices: [],
      fields: [],
      archetypes: {
        astro: { gates: [{ cwd: ".", command: "bun run build" }] },
        boringstack: { gates: [{ cwd: ".", command: "bun run validate" }] },
      },
    });

    await expect(
      runScaffold(
        boring,
        { archetype: "phaser", stack: "dev", values: {} },
        DEST,
        { run, fs, boot: { poll: pollUp } }
      )
    ).rejects.toThrow(/does not declare archetype phaser/iu);
  });
});

describe("gateCommand — phaser", () => {
  test("is the template's bun run check", () => {
    const profile = loadPhaserTemplate().archetypes.phaser;

    expect(profile).toBeDefined();
    expect(gateCommand(profile ?? { gates: [] })).toBe("bun run check");
  });
});
