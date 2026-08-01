import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAutoGate, resolveGate } from "../src/cli/gate-setup";
import { parseArgs } from "../src/cli";
import type { ISessionRecord } from "../src/session-store";
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

    // Cycle 2: the SAME resolver now enables the React pack — no session restart.
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
