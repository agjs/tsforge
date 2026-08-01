import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAutoGate } from "../src/cli/gate-setup";
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

    // A manual override takes control: setGate stops the auto-refresh.
    const callsBeforeOverride = calls;

    session.setGate("exit 0");
    expect(session.gate).toBe("exit 0");

    turn = 0;
    await session.send("more");

    // The manual gate was NOT overwritten by the resolver, and the resolver never ran again.
    expect(session.gate).toBe("exit 0");
    expect(calls).toBe(callsBeforeOverride);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
