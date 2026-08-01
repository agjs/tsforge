import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDriveToGreenSystem } from "../src/loop/prompt/prompt";
import { DEFAULT_CONVENTIONS } from "../src/infer-rules/conventions";
import type { IProvider, IChatMessage } from "../src/inference";
import { Session } from "../src/loop";
import { boringstackConventionProvider } from "../src/loop/boringstack/conventions";

// WS-A4: the drive-to-green system prompt must not CONTRADICT the check tool. When
// check is offered (the boringstack build), the execution guidance promotes it; when
// not, the original "the gate runs automatically, don't run it yourself" stands.

test("with offerCheck, the drive-to-green prompt promotes the check tool", () => {
  const prompt = buildDriveToGreenSystem(DEFAULT_CONVENTIONS, true);

  expect(prompt).toContain("`check`");
  expect(prompt).toContain("before you stop");
  // Shell gate execution is still banned — check is a tool, not `bun run check`.
  expect(prompt).toContain("Do NOT run the gate through the SHELL");
  // The self-contradiction ("do NOT run ... the gate command yourself") is gone.
  expect(prompt).not.toContain("or the acceptance/gate command yourself");
});

test("without offerCheck, the drive-to-green prompt keeps the original gate guidance", () => {
  const prompt = buildDriveToGreenSystem(DEFAULT_CONVENTIONS, false);

  expect(prompt).toContain("the harness AUTOMATICALLY runs the gate");
  expect(prompt).toContain("Do NOT run `tsc`");
  // No mention of a check tool the model wasn't given.
  expect(prompt).not.toContain("`check`");
});

test("offerCheck defaults to false (non-build drive-to-green paths unchanged)", () => {
  expect(buildDriveToGreenSystem(DEFAULT_CONVENTIONS)).toBe(
    buildDriveToGreenSystem(DEFAULT_CONVENTIONS, false)
  );
});

// Session-level wiring: the pure-builder tests above pass even if Session stops
// forwarding cfg.offerCheck. These drive a real Session and inspect the SYSTEM
// message, so a reverted one-liner (tool advertised + gate-ban prompt) fails here.
function systemCapturingProvider(cap: {
  system: string;
  roles?: string[];
  contents?: string[];
}): IProvider {
  return {
    async complete(messages: IChatMessage[]) {
      const sys = messages.find((m) => m.role === "system");

      cap.system = typeof sys?.content === "string" ? sys.content : "";
      cap.roles = messages.map((m) => m.role);
      cap.contents = messages.map((m) =>
        typeof m.content === "string" ? m.content : ""
      );

      return { content: "done", toolCalls: [] };
    },
  };
}

test("a drive-to-green Session with offerCheck puts the check guidance in its system prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-dtg-"));
  const cap = { system: "" };

  try {
    const session = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      offerCheck: true,
    });

    await session.send("go");

    expect(cap.system).toContain("`check`");
    expect(cap.system).not.toContain("or the acceptance/gate command yourself");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a drive-to-green Session WITHOUT offerCheck keeps the original gate guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-dtg-"));
  const cap = { system: "" };

  try {
    const session = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
    });

    await session.send("go");

    expect(cap.system).not.toContain("`check`");
    expect(cap.system).toContain("Do NOT run `tsc`");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Tools inventory lists check and pull_conventions when they are offered", () => {
  const both = buildDriveToGreenSystem(DEFAULT_CONVENTIONS, true, true);

  expect(both).toContain("`check` (run the gate now");
  expect(both).toContain("`pull_conventions`");

  // Neither leaks into the inventory when not offered.
  const neither = buildDriveToGreenSystem(DEFAULT_CONVENTIONS, false, false);
  const toolsLine =
    neither.split("\n").find((l) => l.startsWith("Tools:")) ?? "";

  expect(toolsLine).not.toContain("check");
  expect(toolsLine).not.toContain("pull_conventions");
});

test("a resumed offerCheck session refreshes its system prompt to the check-aware one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-dtg-"));
  const cap: { system: string; roles?: string[] } = { system: "" };

  // A persisted history whose system message predates the check tool (says the old
  // "never run the gate yourself"). On resume WITH offerCheck it must be refreshed.
  const staleHistory = [
    {
      role: "system" as const,
      content:
        "OLD PROMPT: never run `tsc`/the gate yourself; the harness owns it.",
    },
    { role: "user" as const, content: "earlier turn" },
    { role: "assistant" as const, content: "ok" },
  ];

  try {
    const session = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      offerCheck: true,
      history: staleHistory,
    });

    await session.send("continue");

    // The stale system message is gone; the check-aware prompt is in its place.
    expect(cap.system).toContain("`check`");
    expect(cap.system).not.toContain("OLD PROMPT");
    // Two-sided: the refresh must KEEP the prior conversation, not drop it to a lone
    // system message. The earlier user + assistant turns survive after the fresh system.
    expect(cap.roles).toEqual(["system", "user", "assistant", "user"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Tools inventory lists pull_conventions alone when only offerConventions is set", () => {
  const prompt = buildDriveToGreenSystem(DEFAULT_CONVENTIONS, false, true);
  const toolsLine =
    prompt.split("\n").find((l) => l.startsWith("Tools:")) ?? "";

  expect(toolsLine).toContain("`pull_conventions`");
  expect(toolsLine).not.toContain("`check`");
});

test("a resumed pullConventions session (no offerCheck) refreshes to include the convention index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-dtg-"));
  const cap: { system: string; roles?: string[] } = { system: "" };

  const staleHistory = [
    {
      role: "system" as const,
      content: "OLD PROMPT: no convention index here.",
    },
    { role: "user" as const, content: "earlier" },
    { role: "assistant" as const, content: "ok" },
  ];

  try {
    // pullConventions only — NO offerCheck. The unconditional resume refresh must still
    // rebuild the prompt so the convention guides appear in place of the stale one.
    const session = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      pullConventions: true,
      conventions: boringstackConventionProvider,
      history: staleHistory,
    });

    await session.send("continue");

    expect(cap.system).toContain("HOW THIS STACK WRITES CODE");
    expect(cap.system).not.toContain("OLD PROMPT");
    expect(cap.roles).toEqual(["system", "user", "assistant", "user"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume refresh preserves a LATER system message (delegation/scope), replacing only the leading one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-dtg-"));
  const cap: { system: string; roles?: string[]; contents?: string[] } = {
    system: "",
  };

  const laterSystem = "DELEGATION: keep this later system instruction intact.";
  const history = [
    { role: "system" as const, content: "OLD PROMPT: leading base prompt." },
    { role: "user" as const, content: "earlier" },
    { role: "system" as const, content: laterSystem },
    { role: "assistant" as const, content: "ok" },
  ];

  try {
    const session = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      offerCheck: true,
      history,
    });

    await session.send("continue");

    // The LEADING base prompt is replaced; the later system message is NOT dropped —
    // and its CONTENT survives verbatim (a role-only check would pass if it were cleared).
    expect(cap.system).not.toContain("OLD PROMPT");
    expect(cap.roles).toEqual([
      "system",
      "user",
      "system",
      "assistant",
      "user",
    ]);
    expect(cap.contents).toContain(laterSystem);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume refresh is two-directional: a stale check-requiring prompt is dropped when offerCheck is now OFF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-dtg-"));
  const cap: { system: string; roles?: string[] } = { system: "" };

  // History persisted while offerCheck was ON (prompt tells the model to use `check`).
  // Resuming WITHOUT offerCheck must refresh the prompt so it no longer requires a tool
  // the session no longer advertises — the mirror of the on-resume case.
  const staleHistory = [
    {
      role: "system" as const,
      content: "OLD PROMPT: call the `check` tool before you stop.",
    },
    { role: "user" as const, content: "earlier" },
    { role: "assistant" as const, content: "ok" },
  ];

  try {
    const session = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      // offerCheck omitted → the refreshed prompt must NOT mention check.
      history: staleHistory,
    });

    await session.send("continue");

    expect(cap.system).not.toContain("`check`");
    expect(cap.system).not.toContain("OLD PROMPT");
    expect(cap.roles).toEqual(["system", "user", "assistant", "user"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume where history does NOT start with a system message prepends the fresh one, keeping all turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-dtg-"));
  const cap: { system: string; roles?: string[] } = { system: "" };

  const history = [
    { role: "user" as const, content: "no leading system message" },
    { role: "assistant" as const, content: "ok" },
  ];

  try {
    const session = await Session.create({
      provider: systemCapturingProvider(cap),
      cwd: dir,
      files: ["**/*"],
      executionMode: "drive-to-green",
      history,
    });

    await session.send("continue");

    // Fresh system prepended; both original turns survive.
    expect(cap.system.length).toBeGreaterThan(0);
    expect(cap.roles).toEqual(["system", "user", "assistant", "user"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
