import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAutoGate, resolveGate } from "../src/cli/gate-setup";
import { parseArgs } from "../src/cli";
import { autoGateCarry } from "../src/cli/repl";
import {
  saveSession,
  loadSession,
  type ISessionRecord,
  type IGateFloor,
} from "../src/session-store";
import type { IProvider } from "../src/inference";
import type { IStackProfile } from "../src/stack-detection";
import { Session } from "../src/loop";

// THE greenfield bug: stack detection ran once at session start. Starting in an empty
// dir → no package.json → the rule-LESS `generic-ts` fallback, frozen for the whole
// build. As the model wrote a React app, the gate stayed generic-ts, so NO React rules
// ever ran. The auto-gate now re-resolves detection every cycle: resolveAutoGate reads
// the CURRENT package.json each call, so once `react` appears the pack turns on.
test("auto-gate re-detects: generic-ts on an empty dir, react pack once package.json has react", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-redetect-"));

  try {
    // Cycle 1: empty dir → the generic-ts fallback, no framework rules.
    const empty = await resolveAutoGate(dir, "", true);

    expect(empty.command).toContain("generic-ts");
    expect(empty.command).not.toContain("react-component-architecture");

    // The model writes a React app's package.json…
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { react: "19.0.0" } })
    );

    // A fresh resolution now enables the React pack — detection reads the CURRENT
    // package.json each call (two independent resolutions here model two session starts;
    // the WITHIN-session monotonic accumulation is covered by its own test below).
    const withReact = await resolveAutoGate(dir, "", true);

    expect(withReact.command).toContain("react-component-architecture");
    expect(withReact.activePacks).toContain("react-component-architecture");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The ENFORCEMENT boundary: the Session must run the auto-gate resolver every gate cycle
// (re-detecting), and a manual gate override (setGate) must STOP it — otherwise a user
// `/gate <cmd>` would be a silent no-op while the loop keeps running the auto command.
test("Session runs the auto-gate resolver each cycle, and setGate disables it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-autogate-"));

  let calls = 0;
  const stackProfile: IStackProfile = {
    name: "test",
    packs: ["generic-ts"],
    confidence: "guess",
    reason: "test",
  };

  const autoGate = async () => {
    calls += 1;

    return { command: "true", stackProfile };
  };

  // Turn 1 creates a file (an edit → the loop runs the gate); turn 2 ends the drive.
  let turn = 0;
  const provider: IProvider = {
    async complete() {
      turn += 1;

      if (turn === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "1",
              name: "create",
              arguments: { file: "a.ts", content: "export const a = 1;\n" },
            },
          ],
        };
      }

      return { content: "done", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      autoGate,
    });

    await session.send("build it");

    // The resolver ran during the gate cycle and refreshed task.accept to its command.
    expect(calls).toBeGreaterThan(0);
    expect(session.gate).toBe("true");
    // Still auto-driven — the flag /clear + persist read to decide re-attach/re-arm.
    expect(session.autoGateActive).toBe(true);

    // A manual override takes control: setGate stops the auto-refresh.
    const callsBeforeOverride = calls;

    session.setGate("exit 0");
    expect(session.gate).toBe("exit 0");
    // The manual override flips the flag off, so a later /clear or --continue does not
    // silently re-arm the auto gate over the user's command.
    expect(session.autoGateActive).toBe(false);

    turn = 0;
    await session.send("more");

    // The manual gate was NOT overwritten by the resolver, and the resolver never ran again.
    expect(session.gate).toBe("exit 0");
    expect(calls).toBe(callsBeforeOverride);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// The MONOTONIC guarantee closes the gate-relaxation hole: re-detecting the stack every
// cycle must not let the code under test RELAX its own gate. A pack activated once is
// never dropped — deleting a dependency mid-build cannot strip the rules it turned on.
// (Rule overrides / profile / conventions are likewise frozen at capture: the resolver
// never re-reads tsforge.config.json, so the subject can't turn rules off there either.)
test("auto-gate is monotonic: a pack stays active after its dependency is removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-monotonic-"));
  const pkg = join(dir, "package.json");

  try {
    await writeFile(
      pkg,
      JSON.stringify({ name: "x", dependencies: { react: "19.0.0" } })
    );

    const resolved = await resolveGate({ ...parseArgs([]), dir }, null);
    const resolver = resolved.autoGate;

    expect(resolver).toBeDefined();

    if (resolver === undefined) {
      throw new Error("expected an auto-gate resolver for a fresh project");
    }

    // Cycle 1: react present → the React pack is on.
    const first = await resolver();

    expect(first.command).toContain("react-component-architecture");

    // The model deletes react from package.json…
    await writeFile(pkg, JSON.stringify({ name: "x", dependencies: {} }));

    // Cycle 2: the React pack MUST remain — the gate can only get stricter, never looser.
    const second = await resolver();

    expect(second.command).toContain("react-component-architecture");
    expect(second.stackProfile.packs).toContain("react-component-architecture");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The RESUME boundary: `--continue` must re-attach the resolver for an AUTO session (else
// a greenfield resume freezes on generic-ts), keep a manual session's stored command
// verbatim, and — critically — never re-arm the gate for a session saved with the gate
// OFF. A pre-`auto`-field record (legacy) is treated as manual (keeps its command).
test("resume: auto re-attaches the resolver, manual/off keep their stored gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-resume-"));
  const base = { ...parseArgs([]), dir };
  const record = (over: Partial<ISessionRecord>): ISessionRecord => ({
    id: "s",
    cwd: dir,
    accept: "",
    files: [],
    updatedAt: 0,
    messages: [],
    ...over,
  });

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { react: "19.0.0" } })
    );

    // Auto session → resolver re-attached (re-detects on --continue).
    const auto = await resolveGate(
      base,
      record({ accept: "eslint .", auto: true })
    );

    expect(auto.autoGate).toBeDefined();

    // Manual session → keep the stored command, no resolver.
    const manual = await resolveGate(
      base,
      record({ accept: "npm test", auto: false })
    );

    expect(manual.autoGate).toBeUndefined();
    expect(manual.accept).toBe("npm test");

    // --no-gate resume (empty accept, not auto) → stays OFF, no silent re-arm.
    const off = await resolveGate(base, record({ accept: "", auto: false }));

    expect(off.autoGate).toBeUndefined();
    expect(off.accept).toBe("");
    expect(off.gateLabel).toBe("none");

    // Legacy record (no `auto` field) → treated as manual, keeps its command.
    const legacy = await resolveGate(base, record({ accept: "bun x" }));

    expect(legacy.autoGate).toBeUndefined();
    expect(legacy.accept).toBe("bun x");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The test command is captured ONCE and frozen — re-discovering it each cycle let the
// subject swap a real suite for a noop. Repro 1: capture with a real *.test.ts (`bun test`);
// then delete it and add a noop `test` script — a re-discovery would SWITCH the gate to
// `bun run test` (running the noop). Frozen, it stays `bun test`, and never switches.
test("auto-gate freezes the test command at capture (no mid-build re-discovery, no downgrade)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-tests-frozen-"));
  const pkg = join(dir, "package.json");
  const testFile = join(dir, "app.test.ts");

  try {
    await writeFile(pkg, JSON.stringify({ name: "x" }));
    await writeFile(testFile, "export const t = 1;\n");

    const resolved = await resolveGate({ ...parseArgs([]), dir }, null);
    const resolver = resolved.autoGate;

    expect(resolver).toBeDefined();

    if (resolver === undefined) {
      throw new Error("expected an auto-gate resolver for a fresh project");
    }

    // Cycle 1: a real test file → the gate runs `bun test`.
    const first = await resolver();

    expect(first.command).toContain("bun test");

    // The model deletes the test file and adds a noop `test` script.
    await rm(testFile);
    await writeFile(
      pkg,
      JSON.stringify({ name: "x", scripts: { test: "true" } })
    );

    // Cycle 2: the gate is FROZEN on `bun test` — it does not switch to `bun run test`.
    const second = await resolver();

    expect(second.command).toContain("bun test");
    expect(second.command).not.toContain("bun run test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Repro 2: capture with a real `test` script (`bun run test`); mutating the script body to
// a noop mid-build must not make the HARNESS re-read it — the gate command is frozen. (The
// launcher still reads the live script at runtime; that dilution is inherent to any test
// gate and unchanged here — the harness simply never re-discovers a different command.)
test("auto-gate does not re-read the test script mid-build (frozen command string)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-tests-frozen2-"));
  const pkg = join(dir, "package.json");

  try {
    await writeFile(
      pkg,
      JSON.stringify({ name: "x", scripts: { test: "vitest run" } })
    );

    const resolved = await resolveGate({ ...parseArgs([]), dir }, null);
    const resolver = resolved.autoGate;

    expect(resolver).toBeDefined();

    if (resolver === undefined) {
      throw new Error("expected an auto-gate resolver for a fresh project");
    }

    const first = await resolver();

    expect(first.command).toContain("bun run test");

    // Mutate the script body to a noop, and remove it entirely — the frozen command holds.
    await writeFile(
      pkg,
      JSON.stringify({ name: "x", scripts: { test: "exit 0" } })
    );
    expect((await resolver()).command).toContain("bun run test");

    await writeFile(pkg, JSON.stringify({ name: "x" }));
    expect((await resolver()).command).toContain("bun run test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The /clear rebuild path (the stated purpose of the autoGateActive plumbing): a rebuilt
// Session re-attaches the auto resolver ONLY while it is still active. After a manual
// /gate (autoGateActive false) the rebuild must NOT re-arm the auto gate over the user's
// command. Exercised through `autoGateCarry` — the exact guard the /clear spread uses.
test("/clear re-arms the auto gate only while active; a manual override survives the rebuild", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-clear-"));

  const stackProfile: IStackProfile = {
    name: "test",
    packs: ["generic-ts"],
    confidence: "guess",
    reason: "test",
  };

  let calls = 0;

  const resolver = async () => {
    calls += 1;

    return { command: "auto-cmd", stackProfile };
  };

  const makeProvider = (): IProvider => {
    let turn = 0;

    return {
      async complete() {
        turn += 1;

        if (turn === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "a.ts", content: "export const a = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
  };

  try {
    // /clear WHILE ACTIVE: autoGateCarry attaches the resolver, so the rebuild keeps
    // re-detecting (the resolver runs and drives the gate command).
    const active = await Session.create({
      provider: makeProvider(),
      cwd: dir,
      files: ["**/*"],
      accept: "seed",
      ...autoGateCarry(resolver, true),
    });

    await active.send("go");

    expect(calls).toBeGreaterThan(0);
    expect(active.gate).toBe("auto-cmd");

    // /clear AFTER a manual /gate: autoGateActive is false, so autoGateCarry WITHHOLDS the
    // resolver. The rebuilt session keeps the manual command and never re-arms the auto gate.
    const callsBeforeRebuild = calls;
    const manual = await Session.create({
      provider: makeProvider(),
      cwd: dir,
      files: ["**/*"],
      accept: "exit 0",
      ...autoGateCarry(resolver, false),
    });

    await manual.send("go");

    expect(manual.gate).toBe("exit 0");
    expect(calls).toBe(callsBeforeRebuild);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

// The persistence boundary: the `auto` flag must round-trip through saveSession/loadSession
// (the real --continue path), else baseGate can't tell an auto session from a manual one.
test("the session record round-trips the `auto` flag through save/load", async () => {
  const prevHome = process.env.TSFORGE_HOME;
  const home = await mkdtemp(join(tmpdir(), "tsforge-home-"));

  process.env.TSFORGE_HOME = home;

  const base: Omit<ISessionRecord, "id" | "auto"> = {
    cwd: "/x",
    accept: "eslint .",
    files: [],
    updatedAt: 1,
    messages: [],
  };

  try {
    await saveSession({ ...base, id: "auto-on", auto: true });
    await saveSession({ ...base, id: "auto-off", auto: false });
    await saveSession({ ...base, id: "legacy" });

    expect((await loadSession("auto-on"))?.auto).toBe(true);
    expect((await loadSession("auto-off"))?.auto).toBe(false);
    expect((await loadSession("legacy"))?.auto).toBeUndefined();
  } finally {
    if (prevHome === undefined) {
      delete process.env.TSFORGE_HOME;
    } else {
      process.env.TSFORGE_HOME = prevHome;
    }

    await rm(home, { recursive: true, force: true });
  }
});

// The RESUME FLOOR: `--continue` of an auto session must resume NO WEAKER than where it
// left off. A persisted gatePolicy floor (packs the session accumulated, the profile it
// ran under, the frozen test command) is unioned with fresh detection: a pack the subject
// deleted before restart still holds, the profile isn't silently downgraded, and the test
// gate isn't dropped — while a NEWLY added framework is still picked up on top.
test("resume unions the persisted policy floor (packs + profile + testCommand survive --continue)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-floor-"));

  try {
    // A plain project on disk — NO react, NO strict CLI flag, NO test script.
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));

    // Resume with an EXPLICIT weaker CLI profile — the floor's `strict` must still win
    // (else `--continue --profile recommended` would drop type-aware / strict extras).
    const resumed = await resolveGate(
      { ...parseArgs([]), dir, profile: "recommended" },
      {
        id: "s",
        cwd: dir,
        accept: "eslint .",
        auto: true,
        files: [],
        updatedAt: 0,
        messages: [],
        gatePolicy: {
          packs: ["react-component-architecture"],
          profile: "strict",
          ruleOverrides: { "no-explicit-any": "off" },
          testCommand: "bun run test",
        },
      }
    );

    // The pack the last session reached survives (floor union), even though the tree no
    // longer has react.
    expect(resumed.accept).toContain("react-component-architecture");
    // The floor's `strict` beats the weaker `--profile recommended`: its `typescript-core`
    // extra pack is present (a CLI-profile-wins bug would drop it).
    expect(resumed.accept).toContain("typescript-core");
    // The frozen test command is kept even though the tree now has no test script.
    expect(resumed.accept).toContain("bun run test");
    // The returned `policy.packs` carries the floor (unioned) — this is what the REPL
    // seeds its persist accumulator from, so a later weaker stackPacks (post-/clear or a
    // no-edit turn) can't write back a floor that has lost the react pack.
    expect(resumed.policy?.packs).toContain("react-component-architecture");
    expect(resumed.policy?.packs).toContain("typescript-core");
    // The floor's frozen rule-severity overrides are applied — not re-read from a config
    // the subject may have weakened between processes.
    expect(resumed.accept).toContain("no-explicit-any");
    expect(resumed.policy?.ruleOverrides["no-explicit-any"]).toBe("off");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `--strict-floor-only` opts a FRESH session out of tests, but it must NOT drop a resume
// FLOOR's test command — the prior session established tests as part of green.
test("resume keeps the floor's test command even under --strict-floor-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-floor-sfo-"));

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));

    const floor: IGateFloor = {
      packs: [],
      profile: "",
      ruleOverrides: {},
      testCommand: "bun run test",
    };
    const record = {
      id: "s",
      cwd: dir,
      accept: "eslint .",
      auto: true,
      files: [],
      updatedAt: 0,
      messages: [],
      gatePolicy: floor,
    };

    // With a floor test command, --strict-floor-only still runs the tests…
    const resumed = await resolveGate(
      { ...parseArgs([]), dir, strictFloorOnly: true },
      record
    );

    expect(resumed.accept).toContain("bun run test");

    // …but a FRESH --strict-floor-only session (no floor) drops them even with a script.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "vitest run" } })
    );
    const fresh = await resolveGate(
      { ...parseArgs([]), dir, strictFloorOnly: true },
      null
    );

    expect(fresh.accept).not.toContain("bun run test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The persistence boundary for the floor: gatePolicy must round-trip through
// saveSession/loadSession (the real --continue path), and a malformed floor is dropped.
test("the session record round-trips the gatePolicy floor through save/load", async () => {
  const prevHome = process.env.TSFORGE_HOME;
  const home = await mkdtemp(join(tmpdir(), "tsforge-home-floor-"));

  process.env.TSFORGE_HOME = home;

  const base: Omit<ISessionRecord, "id" | "gatePolicy"> = {
    cwd: "/x",
    accept: "eslint .",
    auto: true,
    files: [],
    updatedAt: 1,
    messages: [],
  };

  try {
    await saveSession({
      ...base,
      id: "floored",
      gatePolicy: {
        packs: ["react-component-architecture", "typescript-core"],
        profile: "strict",
        ruleOverrides: { "no-explicit-any": "error" },
        testCommand: "bun run test",
      },
    });
    await saveSession({ ...base, id: "no-floor" });

    const floored = await loadSession("floored");

    expect(floored?.gatePolicy?.packs).toEqual([
      "react-component-architecture",
      "typescript-core",
    ]);
    expect(floored?.gatePolicy?.profile).toBe("strict");
    expect(floored?.gatePolicy?.ruleOverrides).toEqual({
      "no-explicit-any": "error",
    });
    expect(floored?.gatePolicy?.testCommand).toBe("bun run test");

    expect((await loadSession("no-floor"))?.gatePolicy).toBeUndefined();
  } finally {
    if (prevHome === undefined) {
      delete process.env.TSFORGE_HOME;
    } else {
      process.env.TSFORGE_HOME = prevHome;
    }

    await rm(home, { recursive: true, force: true });
  }
});

// parseGateFloor is security-boundary code (untrusted persisted JSON). A wholly malformed
// floor is DROPPED (the record still loads, minus the floor); a partially-valid one is
// sanitized (non-string packs removed, non-severity rule values filtered out).
test("loadSession sanitizes a malformed gatePolicy floor", async () => {
  const prevHome = process.env.TSFORGE_HOME;
  const home = await mkdtemp(join(tmpdir(), "tsforge-home-bad-"));
  const sessions = join(home, ".tsforge", "sessions");

  process.env.TSFORGE_HOME = home;

  const writeRaw = async (id: string, gatePolicy: unknown): Promise<void> => {
    await writeFile(
      join(sessions, `${id}.json`),
      JSON.stringify({
        id,
        cwd: "/x",
        accept: "eslint .",
        auto: true,
        files: [],
        updatedAt: 1,
        messages: [],
        gatePolicy,
      })
    );
  };

  try {
    const { mkdir } = await import("node:fs/promises");

    await mkdir(sessions, { recursive: true });

    // Wholly malformed (testCommand is a number) → the floor is dropped, record still loads.
    await writeRaw("broken", {
      packs: ["ok"],
      profile: "strict",
      ruleOverrides: {},
      testCommand: 7,
    });
    const broken = await loadSession("broken");

    expect(broken).not.toBeNull();
    expect(broken?.gatePolicy).toBeUndefined();

    // Partially valid → non-string packs dropped, non-severity rule values filtered.
    await writeRaw("dirty", {
      packs: ["good", 123, "also-good"],
      profile: "strict",
      ruleOverrides: { keep: "off", drop: "nonsense" },
      testCommand: null,
    });
    const dirty = await loadSession("dirty");

    expect(dirty?.gatePolicy?.packs).toEqual(["good", "also-good"]);
    expect(dirty?.gatePolicy?.ruleOverrides).toEqual({ keep: "off" });
    expect(dirty?.gatePolicy?.testCommand).toBeNull();

    // Missing ruleOverrides → the WHOLE floor is dropped (else resume would freeze an
    // empty override set, silently dropping strict meta-rules).
    await writeRaw("no-overrides", {
      packs: ["ok"],
      profile: "strict",
      testCommand: null,
    });

    expect((await loadSession("no-overrides"))?.gatePolicy).toBeUndefined();

    // A present-but-invalid profile → floor dropped (a bogus profile must not suppress
    // the CLI profile on resume).
    await writeRaw("bad-profile", {
      packs: ["ok"],
      profile: "not-a-real-profile",
      ruleOverrides: {},
      testCommand: null,
    });

    expect((await loadSession("bad-profile"))?.gatePolicy).toBeUndefined();
  } finally {
    if (prevHome === undefined) {
      delete process.env.TSFORGE_HOME;
    } else {
      process.env.TSFORGE_HOME = prevHome;
    }

    await rm(home, { recursive: true, force: true });
  }
});
