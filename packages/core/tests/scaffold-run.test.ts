import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gateCommand,
  runScaffold,
  scaffoldPhaseReporter,
  makeScaffoldRunDeps,
} from "../src/scaffold/run-scaffold";
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

describe("scaffoldPhaseReporter", () => {
  test("forwards each phase to the sink as a formatted '  → …' line", () => {
    const lines: string[] = [];
    const report = scaffoldPhaseReporter((line) => lines.push(line));

    report("Cloning the project template…");
    report("Applying your configuration…");

    expect(lines).toEqual([
      "  → Cloning the project template…\n",
      "  → Applying your configuration…\n",
    ]);
  });
});

describe("makeScaffoldRunDeps — the deps both entry points hand to runScaffold", () => {
  const noop = (): void => undefined;

  test("wires onPhase to the sink with the standard progress-line format", () => {
    // This factory is the ONLY place the onPhase wiring lives; both entry points
    // delegate to it (openScaffoldInRepl passes deps.out, runScaffoldCommand passes
    // stdout), so the format/forwarding logic is fully covered here. The callers'
    // one-line `makeScaffoldRunDeps(<sink>)` pass-through carries no further logic.
    const lines: string[] = [];
    const deps = makeScaffoldRunDeps((line) => lines.push(line));

    deps.onPhase?.("Applying your configuration…");

    expect(lines).toEqual(["  → Applying your configuration…\n"]);
  });

  test("passes skipBoot through, and omits it when unset", () => {
    expect(makeScaffoldRunDeps(noop, { skipBoot: true }).skipBoot).toBe(true);
    expect(makeScaffoldRunDeps(noop).skipBoot).toBeUndefined();
  });

  test("supplies the real runner/fs/poller so a caller need only give the sink", () => {
    const deps = makeScaffoldRunDeps(noop);

    expect(typeof deps.run).toBe("function");
    expect(typeof deps.fs.readText).toBe("function");
    expect(typeof deps.boot.poll).toBe("function");
  });
});

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

  test("reports each phase via onPhase (clone → configure → boot), in order", async () => {
    const { fs } = memFs({
      [`${DEST}/infra/compose/compose/.env.example`]: "STACK=dev\n",
    });
    const phases: string[] = [];

    await runScaffold(MANIFEST, answers("boringstack"), DEST, {
      run: runner(),
      fs,
      boot: { poll: pollUp },
      onPhase: (m) => phases.push(m),
    });

    expect(phases).toHaveLength(3);
    expect(phases[0]).toContain("Cloning");
    expect(phases[1]).toContain("configuration");
    expect(phases[2]).toContain("Starting services");
  });

  test("onPhase reports only clone + configure when boot is skipped", async () => {
    const { fs } = memFs({
      [`${DEST}/infra/compose/compose/.env.example`]: "STACK=dev\n",
    });
    const phases: string[] = [];

    await runScaffold(MANIFEST, answers("boringstack"), DEST, {
      run: runner(),
      fs,
      boot: { poll: pollUp },
      skipBoot: true,
      onPhase: (m) => phases.push(m),
    });

    // Exactly the two non-boot phases, in order — no "starting services" the run
    // won't perform.
    expect(phases).toHaveLength(2);
    expect(phases[0]).toContain("Cloning");
    expect(phases[1]).toContain("configuration");
  });

  test("astro never reports a boot phase (static build, no stack)", async () => {
    const { fs } = memFs();
    const phases: string[] = [];

    await runScaffold(MANIFEST, answers("astro"), DEST, {
      run: runner(),
      fs,
      boot: { poll: pollUp },
      onPhase: (m) => phases.push(m),
    });

    expect(phases.some((p) => p.includes("Starting services"))).toBe(false);
    // The clone message is archetype-neutral — no "BoringStack" on an astro scaffold.
    expect(phases[0]).toContain("Cloning the project template");
    expect(phases.some((p) => p.includes("BoringStack"))).toBe(false);
  });

  test("strips the template's apps/docs from a boringstack (full-stack) scaffold", async () => {
    const { fs, store } = memFs({
      [`${DEST}/infra/compose/compose/.env.example`]: "STACK=dev\n",
      // the template ships its own docs site — a product must NOT carry it
      [`${DEST}/apps/docs/package.json`]: "{}",
      [`${DEST}/apps/docs/astro.config.mjs`]: "export default {};",
      // the product apps must survive
      [`${DEST}/apps/api/package.json`]: "{}",
    });

    await runScaffold(MANIFEST, answers("boringstack"), DEST, {
      run: runner(),
      fs,
      boot: { poll: pollUp },
      skipBoot: true,
    });

    expect(store.has(`${DEST}/apps/docs/package.json`)).toBe(false);
    expect(store.has(`${DEST}/apps/docs/astro.config.mjs`)).toBe(false);
    // product code is untouched
    expect(store.has(`${DEST}/apps/api/package.json`)).toBe(true);
  });

  test("astro archetype KEEPS apps/docs — it is the product, not template cruft", async () => {
    const { fs, store } = memFs({
      [`${DEST}/apps/docs/package.json`]: "{}",
    });

    await runScaffold(MANIFEST, answers("astro"), DEST, {
      run: runner(),
      fs,
      boot: { poll: pollUp },
      skipBoot: true,
    });

    expect(store.has(`${DEST}/apps/docs/package.json`)).toBe(true);
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

describe("runScaffold — clone manifest is the source of truth (Codex P1)", () => {
  test("uses the cloned repo's manifest over the bundled bootstrap", async () => {
    // The clone ships its OWN manifest (here manifestVersion 2); runScaffold must
    // plan/record from THAT, not the bundled v1 it was handed for bootstrap.
    const cloneManifest = JSON.parse(
      readFileSync(
        join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
        "utf8"
      )
    );

    cloneManifest.manifestVersion = 2;

    const { fs, store } = memFs({
      [`${DEST}/infra/compose/compose/.env.example`]: "STACK=dev\n",
      [`${DEST}/.tsforge/scaffold-manifest.json`]:
        JSON.stringify(cloneManifest),
    });

    await runScaffold(MANIFEST, answers("boringstack"), DEST, {
      run: runner(),
      fs,
      boot: { poll: pollUp },
      skipBoot: true,
    });

    const record = JSON.parse(
      store.get(`${DEST}/.tsforge/scaffold.json`) ?? "{}"
    );

    expect(record.manifestVersion).toBe(2); // the clone's, not bundled v1
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

describe("runScaffold — clone manifest is the ONLY source of truth (Codex P1 round 2)", () => {
  const fixturePath = join(
    import.meta.dir,
    "fixtures/scaffold/scaffold-manifest.json"
  );

  test("validation uses the clone's rules, not stale bundled cross-rules", async () => {
    // EMAIL_PROVIDER=smtp + WITH_MAILPIT=0 violates the BUNDLED smtp⇒mailpit rule.
    // A clone whose manifest dropped that rule must NOT be rejected.
    const relaxed = JSON.parse(readFileSync(fixturePath, "utf8"));

    relaxed.crossRules = [];

    const { fs } = memFs({
      [`${DEST}/infra/compose/compose/.env.example`]: "STACK=dev\n",
      [`${DEST}/.tsforge/scaffold-manifest.json`]: JSON.stringify(relaxed),
    });

    const outcome = await runScaffold(
      MANIFEST,
      answers("boringstack", { EMAIL_PROVIDER: "smtp", WITH_MAILPIT: "0" }),
      DEST,
      { run: runner(), fs, boot: { poll: pollUp }, skipBoot: true }
    );

    expect(outcome.dir).toBe(DEST); // succeeded — not rejected by the stale bundle
  });

  test("a malformed cloned manifest throws (no silent fallback to the bundle)", async () => {
    const { fs } = memFs({
      [`${DEST}/infra/compose/compose/.env.example`]: "STACK=dev\n",
      [`${DEST}/.tsforge/scaffold-manifest.json`]: "{ not valid json",
    });

    await expect(
      runScaffold(MANIFEST, answers("boringstack"), DEST, {
        run: runner(),
        fs,
        boot: { poll: pollUp },
        skipBoot: true,
      })
    ).rejects.toThrow(/present but invalid|refusing/iu);
  });
});
