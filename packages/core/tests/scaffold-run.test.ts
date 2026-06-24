import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gateCommand, runScaffold } from "../src/scaffold/run-scaffold";
import { parseManifest } from "../src/scaffold/boringstack-manifest";
import type {
  IScaffoldFs,
  IReadyPoller,
  IScaffoldRunner,
} from "../src/scaffold/io";
import type { IShellRun } from "../src/lib/fs/process";
import type { IScaffoldAnswers } from "../src/scaffold";

const MANIFEST = parseManifest(
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
      "utf8"
    )
  )
);

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
  };

  return { fs, store };
}

const SHA = "c643a0edeadbeef00000000000000000000beef0";

function runner(): IScaffoldRunner {
  return (_cwd, argv) =>
    Promise.resolve<IShellRun>({
      stdout: argv[1] === "rev-parse" ? `${SHA}\n` : "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
}

const pollUp: IReadyPoller = () => Promise.resolve(200);

function answers(
  archetype: IScaffoldAnswers["archetype"],
  values: Record<string, string | readonly string[]> = {}
): IScaffoldAnswers {
  return { archetype, stack: "dev", values };
}

const DEST = "/tmp/proj";

describe("gateCommand", () => {
  test("composes boringstack's per-app gates into one && chain", () => {
    const cmd = gateCommand(MANIFEST.archetypes.boringstack);

    expect(cmd).toBe(
      "(cd apps/api && bun run validate) && (cd apps/ui && bun run validate) && bun run check"
    );
  });

  test("a single root gate (astro) is just the command", () => {
    expect(gateCommand(MANIFEST.archetypes.astro)).toBe("bun run build");
  });
});

describe("runScaffold — full boringstack", () => {
  test("clones, records replay metadata, configures, boots, and hands off the gate", async () => {
    const { fs, store } = memFs({
      [`${DEST}/infra/compose/compose/.env.example`]: "STACK=dev\n",
    });

    const outcome = await runScaffold(MANIFEST, answers("boringstack"), DEST, {
      run: runner(),
      fs,
      boot: { poll: pollUp },
    });

    expect(outcome.resolvedSha).toBe(SHA);
    expect(outcome.booted).toBe(true);
    expect(outcome.gateCwd).toBe(DEST);
    expect(outcome.gateCommand).toContain("bun run validate");

    // replay record persisted
    const record = JSON.parse(
      store.get(`${DEST}/.tsforge/scaffold.json`) ?? "{}"
    );

    expect(record).toMatchObject({
      source: MANIFEST.repo,
      resolvedSha: SHA,
      archetype: "boringstack",
      manifestVersion: 1,
    });
  });

  test("skipBoot stands up the project without booting Docker", async () => {
    const { fs } = memFs({
      [`${DEST}/infra/compose/compose/.env.example`]: "STACK=dev\n",
    });
    let polled = false;

    const poll: IReadyPoller = () => {
      polled = true;

      return Promise.resolve(200);
    };

    const outcome = await runScaffold(MANIFEST, answers("boringstack"), DEST, {
      run: runner(),
      fs,
      boot: { poll },
      skipBoot: true,
    });

    expect(outcome.booted).toBe(false);
    expect(polled).toBe(false);
    expect(outcome.gateCommand).toContain("bun run validate");
  });

  test("refuses to apply an invalid configuration (cross-rule violation)", async () => {
    const { fs } = memFs();

    await expect(
      runScaffold(
        MANIFEST,
        answers("boringstack", { EMAIL_PROVIDER: "smtp", WITH_MAILPIT: "0" }),
        DEST,
        { run: runner(), fs, boot: { poll: pollUp } }
      )
    ).rejects.toThrow(/invalid/iu);
  });
});

describe("runScaffold — astro", () => {
  test("hands off the subPath dir with the build gate, no boot", async () => {
    const { fs } = memFs();

    const outcome = await runScaffold(MANIFEST, answers("astro"), DEST, {
      run: runner(),
      fs,
      boot: { poll: pollUp },
    });

    expect(outcome.gateCwd).toBe(`${DEST}/apps/docs`);
    expect(outcome.gateCommand).toBe("bun run build");
    expect(outcome.booted).toBe(false);
  });
});
