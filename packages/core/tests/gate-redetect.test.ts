import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGate } from "../src/cli/gate-setup";
import { parseArgs } from "../src/cli";
import { profileFlagError } from "../src/cli/args";
import { isProfileId } from "../src/config/profiles";
import { autoGateCarry, resumedProfileArg } from "../src/cli/repl";
import {
  saveSession,
  loadSession,
  type ISessionRecord,
} from "../src/session-store";
import type { IProvider } from "../src/inference";
import type { IStackProfile } from "../src/stack-detection";
import { Session } from "../src/loop";

// THE greenfield bug: stack detection ran once at session start. Starting in an empty
// dir used to freeze a soft floor; the auto gate now re-resolves every cycle so once
// `react` appears the framework pack turns on. Empty dir still gets always-on packs.
test("auto-gate re-detects: always-on on an empty dir, react pack once package.json has react", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-redetect-"));

  try {
    // Cycle 1: empty dir → always-on packs, no framework rules.
    const empty = await resolveGate({ ...parseArgs([]), dir }, null);

    expect(empty.accept).toContain("generic-ts");
    expect(empty.accept).toContain("env-access");
    expect(empty.accept).toContain("code-flow");
    expect(empty.accept).not.toContain("react-component-architecture");

    // The model writes a React app's package.json…
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { react: "19.0.0" } })
    );

    // A fresh resolution now enables the React pack — detection reads the CURRENT
    // package.json each call (two independent resolutions here model two session starts;
    // the WITHIN-session monotonic accumulation is covered by its own test below).
    const withReact = await resolveGate({ ...parseArgs([]), dir }, null);

    expect(withReact.accept).toContain("react-component-architecture");

    // …and the session resolver carries it too (the per-cycle refresh).
    const resolver = withReact.autoGate;

    expect(resolver).toBeDefined();

    if (resolver === undefined) {
      throw new Error("expected an auto-gate resolver for a fresh project");
    }

    expect((await resolver()).stackProfile.packs).toContain(
      "react-component-architecture"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// THE core fix, exercised on a SINGLE resolver (not two independent resolutions): a build
// starts empty (always-on only), writes a framework's package.json MID-SESSION, and the
// SAME resolver's next cycle activates that pack. A regression that only ever re-used the
// captured baseline packs (never re-detecting) would fail this — the whole point of #105.
test("a single resolver activates a framework pack when package.json gains it mid-session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-midsession-"));

  try {
    // Start EMPTY → always-on packs, no framework packs.
    const resolved = await resolveGate({ ...parseArgs([]), dir }, null);
    const resolver = resolved.autoGate;

    expect(resolver).toBeDefined();

    if (resolver === undefined) {
      throw new Error("expected an auto-gate resolver for a fresh project");
    }

    const before = await resolver();

    expect(before.command).toContain("generic-ts");
    expect(before.command).toContain("env-access");
    expect(before.command).not.toContain("react-component-architecture");

    // The build writes a React package.json partway through…
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { react: "19.0.0" } })
    );

    // …the SAME resolver's next cycle now enables the React pack (live re-detection).
    const after = await resolver();

    expect(after.command).toContain("react-component-architecture");
    expect(after.stackProfile.packs).toContain("react-component-architecture");
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

// Live Check: + pack notice: auto-gate must refresh the task-contract and tell the
// model when packs grow — otherwise the prompt keeps a stale soft command.
test("auto-gate refreshes Check: and injects Detected packs: when packs grow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-gate-vis-"));

  let cycle = 0;

  const autoGate = async () => {
    cycle += 1;

    if (cycle === 1) {
      return {
        command: "echo gate-v1",
        stackProfile: {
          name: "v1",
          packs: ["generic-ts", "env-access"],
          confidence: "guess" as const,
          reason: "test",
        },
      };
    }

    return {
      command: "echo gate-v2",
      stackProfile: {
        name: "v2",
        packs: ["generic-ts", "env-access", "react-component-architecture"],
        confidence: "certain" as const,
        reason: "react appeared",
      },
    };
  };

  let fileSeq = 0;
  let pendingCreate = false;
  const provider: IProvider = {
    async complete() {
      if (!pendingCreate) {
        pendingCreate = true;
        fileSeq += 1;

        return {
          content: "",
          toolCalls: [
            {
              id: String(fileSeq),
              name: "create",
              arguments: {
                file: `f${String(fileSeq)}.ts`,
                content: `export const n = ${String(fileSeq)};\n`,
              },
            },
          ],
        };
      }

      pendingCreate = false;

      return { content: "done", toolCalls: [] };
    },
  };

  try {
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      accept: "echo stale",
      autoGate,
    });

    await session.send("first");

    const system1 = session.messages[0];

    expect(system1?.role).toBe("system");
    expect(system1?.content ?? "").toContain("Check: `echo gate-v1`");
    expect(system1?.content ?? "").not.toContain("Check: `echo stale`");
    expect(
      session.messages.some(
        (m) => m.role === "user" && m.content.startsWith("Detected packs:")
      )
    ).toBe(false);

    await session.send("second");

    const system2 = session.messages[0];

    expect(system2?.content ?? "").toContain("Check: `echo gate-v2`");
    expect(
      session.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.startsWith("Detected packs:") &&
          m.content.includes("newly activated: react-component-architecture")
      )
    ).toBe(true);
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

// The load-bearing WITHIN-SESSION freeze: the policy (rule overrides / profile / conventions)
// is captured ONCE, so the code under test cannot relax its own gate by editing
// tsforge.config.json between cycles. Only the stack re-detects (additively). A frozen
// policy means the gate command is byte-identical across a mid-build config mutation.
test("within-session freeze: mutating tsforge.config.json mid-build does not change the gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-freeze-cfg-"));

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));

    const resolved = await resolveGate({ ...parseArgs([]), dir }, null);
    const resolver = resolved.autoGate;

    expect(resolver).toBeDefined();

    if (resolver === undefined) {
      throw new Error("expected an auto-gate resolver for a fresh project");
    }

    const first = await resolver();

    // The subject writes a config that turns rules OFF mid-build.
    await writeFile(
      join(dir, "tsforge.config.json"),
      JSON.stringify({
        rules: { "no-explicit-any": "off", "no-console": "off" },
      })
    );

    const second = await resolver();

    // Frozen: identical command — the resolver never re-reads the config's overrides.
    expect(second.command).toBe(first.command);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Strictness must survive `--continue`: a build started with `--profile strict` keeps it on
// resume without the user re-typing the flag (a project resumed months later stays at the
// level it was built at). resumedProfileArg fills the saved profile in when none is passed
// THIS run; an explicit CLI profile still wins.
test("resumedProfileArg keeps a resumed session's profile unless the CLI passes one", () => {
  const rec = (profile?: string): ISessionRecord => ({
    id: "s",
    cwd: "/x",
    accept: "",
    files: [],
    updatedAt: 0,
    messages: [],
    ...(profile === undefined ? {} : { profile }),
  });

  // No CLI profile + a saved one → the saved profile is restored.
  expect(resumedProfileArg("", rec("strict"))).toBe("strict");
  // An explicit CLI profile THIS run wins over the saved one.
  expect(resumedProfileArg("security", rec("strict"))).toBe("security");
  // No saved profile (or no session) → whatever the CLI passed (incl. none).
  expect(resumedProfileArg("", rec(undefined))).toBe("");
  expect(resumedProfileArg("", null)).toBe("");
  // A corrupted / hand-edited saved profile is IGNORED (never applied or re-persisted).
  expect(resumedProfileArg("", rec("bogus"))).toBe("");
  expect(resumedProfileArg("", rec("__proto__"))).toBe("");
});

// A typo'd or value-less `--profile` must fail loudly (return an error), not silently run
// at the default and quietly drop the strictness the user asked for.
test("profileFlagError rejects invalid/value-less --profile, accepts valid or absent", () => {
  // Valid id → no error.
  expect(profileFlagError("strict", true)).toBeNull();
  expect(profileFlagError("recommended", false)).toBeNull();
  // Not indicated at all (no value, no flag) → no error (config/default drives it).
  expect(profileFlagError("", false)).toBeNull();
  // A typo → error.
  expect(profileFlagError("strcit", true)).toContain(
    'unknown --profile "strcit"'
  );
  // A trailing `--profile` with no value (flag present, value empty) → error.
  expect(profileFlagError("", true)).toContain("unknown --profile");
  // A prototype-chain name → error (not a real id).
  expect(profileFlagError("constructor", true)).toContain("unknown --profile");
});

// A THIS-run explicit gate override must win over a resumed AUTO session — `--continue
// --accept "..."` uses that command, and `--continue --no-gate` actually turns the gate
// off, instead of silently re-arming the auto resolver.
test("baseGate: explicit --accept / --no-gate win over a resumed auto session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-resume-override-"));
  const autoRecord: ISessionRecord = {
    id: "s",
    cwd: dir,
    accept: "eslint .",
    auto: true,
    files: [],
    updatedAt: 0,
    messages: [],
  };

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));

    // --continue --accept "npm test" → uses npm test, NOT the auto resolver.
    const withAccept = await resolveGate(
      { ...parseArgs([]), dir, accept: "npm test" },
      autoRecord
    );

    expect(withAccept.accept).toBe("npm test");
    expect(withAccept.autoGate).toBeUndefined();

    // --continue --no-gate → gate OFF, not a silent auto re-arm.
    const withNoGate = await resolveGate(
      { ...parseArgs([]), dir, noGate: true },
      autoRecord
    );

    expect(withNoGate.accept).toBe("");
    expect(withNoGate.autoGate).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// End-to-end: the profile round-trips through save/load, and once applied the gate resolves
// at that strictness — `strict` brings its `typescript-core` extra pack that the default lacks.
test("resume persists --profile strict and the resolved gate reflects it", async () => {
  const prevHome = process.env.TSFORGE_HOME;
  const home = await mkdtemp(join(tmpdir(), "tsforge-home-profile-"));
  const dir = await mkdtemp(join(tmpdir(), "tsforge-profile-"));

  process.env.TSFORGE_HOME = home;

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));

    // A session started with --profile strict round-trips the profile.
    await saveSession({
      id: "strict-sess",
      cwd: dir,
      accept: "eslint .",
      auto: true,
      profile: "strict",
      files: [],
      updatedAt: 1,
      messages: [],
    });
    const loaded = await loadSession("strict-sess");

    expect(loaded?.profile).toBe("strict");

    // Applying that profile (what the resume overlay does) resolves the gate at strict — its
    // typescript-core extra pack is present; the default profile does not carry it.
    const strict = await resolveGate(
      { ...parseArgs([]), dir, profile: resumedProfileArg("", loaded) },
      loaded
    );

    expect(strict.accept).toContain("typescript-core");

    const dflt = await resolveGate({ ...parseArgs([]), dir }, null);

    expect(dflt.accept).not.toContain("typescript-core");
  } finally {
    if (prevHome === undefined) {
      delete process.env.TSFORGE_HOME;
    } else {
      process.env.TSFORGE_HOME = prevHome;
    }

    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

// The `--profile <id>` CLI flag must actually parse into args.profile (it feeds the gate,
// the Session, and the persisted strictness). A bare word after it is the VALUE, not task.
test("parseArgs reads --profile as a value flag", () => {
  expect(parseArgs(["--profile", "strict"]).profile).toBe("strict");
  expect(parseArgs(["--profile", "strict", "--continue"]).profile).toBe(
    "strict"
  );
  // No flag → empty (config/default drives the profile).
  expect(parseArgs([]).profile).toBe("");
});

// isProfileId is a validation boundary for persisted/CLI profile strings — it must accept
// real profile ids and REJECT prototype-chain names ("constructor", "__proto__", …).
test("isProfileId accepts real ids and rejects prototype-chain names", () => {
  expect(isProfileId("strict")).toBe(true);
  expect(isProfileId("recommended")).toBe(true);
  expect(isProfileId("opinionated")).toBe(true);

  expect(isProfileId("constructor")).toBe(false);
  expect(isProfileId("__proto__")).toBe(false);
  expect(isProfileId("toString")).toBe(false);
  expect(isProfileId("nope")).toBe(false);
  expect(isProfileId("")).toBe(false);
});

// FG-2 (session boundary): a resolver-reported downgrade must red the gate cycle,
// keep the previous accept command, and NOT adopt the weaker one.
test("Session reds the gate cycle on a stage-floor downgrade instead of adopting a weaker command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-floor-red-"));

  const stackProfile: IStackProfile = {
    name: "test",
    packs: ["generic-ts"],
    confidence: "guess",
    reason: "test",
  };
  let downgraded = false;
  let sawDowngradeCycle = 0;

  const autoGate = async () => {
    if (!downgraded) {
      return { command: "exit 0", stackProfile };
    }

    sawDowngradeCycle += 1;

    return {
      command: "true",
      stackProfile,
      downgrade: 'gate integrity: the "tsc --strict" stage vanished',
    };
  };

  let turn = 0;
  let fileSeq = 0;
  const provider: IProvider = {
    async complete() {
      turn += 1;

      if (turn === 1) {
        fileSeq += 1;

        return {
          content: "",
          toolCalls: [
            {
              id: String(fileSeq),
              name: "create",
              arguments: {
                file: `f${String(fileSeq)}.ts`,
                content: "export const a = 1;\n",
              },
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

    // Send 1: normal cycle — the resolver's command is adopted.
    await session.send("build it");
    expect(session.gate).toBe("exit 0");

    // Send 2: the project was tampered with (resolver reports a downgrade).
    downgraded = true;
    turn = 0;
    await session.send("more");

    // The downgrade cycle ran, the gate went red with gate-integrity (send 2
    // cannot settle green), and the weaker command was NEVER adopted.
    expect(sawDowngradeCycle).toBeGreaterThan(0);
    expect(session.gate).toBe("exit 0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

// FG-2 (container flip): deleting the root package.json mid-session flips
// isWorkspaceContainer → before the floor, the auto gate downgraded a real
// package gate to the container green-skip (accept "true") over a broken tree.
test("Session refuses the package→container downgrade when root package.json vanishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-container-flip-"));

  const stackProfile: IStackProfile = {
    name: "test",
    packs: ["generic-ts"],
    confidence: "guess",
    reason: "test",
  };
  let resolverCalls = 0;

  const autoGate = async () => {
    resolverCalls += 1;

    return { command: "exit 0", stackProfile };
  };

  let turn = 0;
  let fileSeq = 0;
  const provider: IProvider = {
    async complete() {
      turn += 1;

      if (turn === 1) {
        fileSeq += 1;

        return {
          content: "",
          toolCalls: [
            {
              id: String(fileSeq),
              name: "create",
              arguments: {
                file: `src/f${String(fileSeq)}.ts`,
                content: "export const a = 1;\n",
              },
            },
          ],
        };
      }

      return { content: "done", toolCalls: [] };
    },
  };

  try {
    // A root package.json + a child package: deleting the root later makes
    // isWorkspaceContainer(dir) true.
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "api"), { recursive: true });
    await writeFile(
      join(dir, "api", "package.json"),
      JSON.stringify({ name: "api" })
    );

    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      autoGate,
    });

    await session.send("build it");
    expect(session.gate).toBe("exit 0");

    const callsAfterSend1 = resolverCalls;

    // The code under test (or anything else) removes the root package.json.
    await rm(join(dir, "package.json"));

    turn = 0;
    await session.send("more");

    // The container branch red-flagged BEFORE resolving/adopting anything:
    // the persisted accept never became the container skip's literal "true".
    expect(session.gate).toBe("exit 0");
    expect(session.gate).not.toBe("true");
    expect(resolverCalls).toBe(callsAfterSend1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
