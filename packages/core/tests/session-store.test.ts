import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession, latestSession, redactText } from "../src/session-store";

let home = "";
const original = process.env.TSFORGE_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tsforge-home-"));
  process.env.TSFORGE_HOME = home;
});

afterEach(async () => {
  process.env.TSFORGE_HOME = original;
  delete process.env.TSFORGE_NO_PERSIST;
  await rm(home, { recursive: true, force: true });
});

test("latestSession returns null when nothing is saved", async () => {
  expect(await latestSession("/some/dir")).toBeNull();
});

test("saves and resumes the newest session for a directory", async () => {
  await saveSession({
    id: "old",
    cwd: "/proj/a",
    accept: "bun test",
    files: ["src/**/*.ts"],
    updatedAt: 1000,
    messages: [{ role: "system", content: "sys" }],
  });
  await saveSession({
    id: "new",
    cwd: "/proj/a",
    accept: "bun test",
    files: ["src/**/*.ts"],
    updatedAt: 2000,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "read", arguments: { file: "a.ts" } }],
      },
    ],
  });
  // a different directory must not be picked up
  await saveSession({
    id: "other",
    cwd: "/proj/b",
    accept: "",
    files: [],
    updatedAt: 3000,
    messages: [{ role: "system", content: "sys" }],
  });

  const resumed = await latestSession("/proj/a");

  expect(resumed?.id).toBe("new");
  expect(resumed?.messages.length).toBe(3);
  expect(resumed?.messages[2]?.toolCalls?.[0]?.name).toBe("read");
});

test("redactText scrubs secret shapes but keeps assignment key names", () => {
  expect(redactText("here is sk-abcdefghijklmnopqrstuvwx")).not.toContain(
    "sk-abcdefghij"
  );
  expect(redactText("export API_KEY=supersecretvalue123")).toBe(
    "export API_KEY=[redacted]"
  );

  const pw = redactText("password: hunter2hunter");

  expect(pw).toContain("password");
  expect(pw).toContain("[redacted]");

  expect(redactText("Authorization: Bearer abcdef123456ghijklmn")).toContain(
    "[redacted]"
  );
  expect(redactText("just a normal sentence")).toBe("just a normal sentence");
});

test("secrets are redacted before they reach disk", async () => {
  await saveSession({
    id: "sec",
    cwd: "/proj/sec",
    accept: "",
    files: [],
    updatedAt: 1,
    messages: [{ role: "user", content: "my key sk-abcdefghijklmnopqrstuv" }],
  });

  const resumed = await latestSession("/proj/sec");

  expect(resumed?.messages[0]?.content).not.toContain("sk-abcdefghij");
  expect(resumed?.messages[0]?.content).toContain("[redacted]");
});

test("redacts secrets inside tool-call arguments too", async () => {
  await saveSession({
    id: "args",
    cwd: "/proj/args",
    accept: "",
    files: [],
    updatedAt: 1,
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "1",
            name: "run",
            arguments: { command: "export TOKEN=sk-abcdefghijklmnop && go" },
          },
        ],
      },
    ],
  });

  const resumed = await latestSession("/proj/args");
  const command = String(
    resumed?.messages[0]?.toolCalls?.[0]?.arguments.command
  );

  expect(command).not.toContain("sk-abcdefghij");
  expect(command).toContain("[redacted]");
});

test("written session file is owner-only (0600)", async () => {
  await saveSession({
    id: "perm",
    cwd: "/proj/p",
    accept: "",
    files: [],
    updatedAt: 1,
    messages: [{ role: "system", content: "sys" }],
  });

  const info = await stat(join(home, ".tsforge", "sessions", "perm.json"));

  // POSIX permission bits — owner read/write only.
  expect(info.mode & 0o777).toBe(0o600);
});

test("saveSession is a no-op when persistence is disabled", async () => {
  process.env.TSFORGE_NO_PERSIST = "1";

  await saveSession({
    id: "nope",
    cwd: "/proj/np",
    accept: "",
    files: [],
    updatedAt: 1,
    messages: [{ role: "system", content: "sys" }],
  });

  expect(await latestSession("/proj/np")).toBeNull();
});
