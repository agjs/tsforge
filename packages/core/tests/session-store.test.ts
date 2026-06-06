import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession, latestSession } from "../src/session-store";

let home = "";
const original = process.env.TSFORGE_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tsforge-home-"));
  process.env.TSFORGE_HOME = home;
});

afterEach(async () => {
  process.env.TSFORGE_HOME = original;
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
