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

test("resume preserves planMode (read-only guarantee survives --continue)", async () => {
  await saveSession({
    id: "pm",
    cwd: "/proj/pm",
    accept: "",
    files: [],
    updatedAt: 1000,
    planMode: true,
    messages: [{ role: "system", content: "sys" }],
  });

  const resumed = await latestSession("/proj/pm");

  expect(resumed?.planMode).toBe(true);
});

test("resume preserves activePlanId (session-bound plan survives --continue)", async () => {
  await saveSession({
    id: "s-plan",
    cwd: "/proj/plan",
    accept: "",
    files: [],
    updatedAt: Date.now(),
    activePlanId: "plan-abc",
    messages: [{ role: "user", content: "hi" }],
  });

  const latest = await latestSession("/proj/plan");

  expect(latest?.activePlanId).toBe("plan-abc");
});

test("resume preserves pausedWithEdit (deferred gate survives --continue)", async () => {
  // WS-C: a still-unvalidated pre-pause edit must survive the process boundary, or
  // --continue silently drops the deferred gate (the same hole /clear closed in-process).
  await saveSession({
    id: "pwe",
    cwd: "/proj/pwe",
    accept: "",
    files: [],
    updatedAt: 1000,
    pausedWithEdit: true,
    messages: [{ role: "system", content: "sys" }],
  });

  const resumed = await latestSession("/proj/pwe");

  expect(resumed?.pausedWithEdit).toBe(true);
});

test("resume preserves touched (workspace gate fan-out survives --continue)", async () => {
  await saveSession({
    id: "touch",
    cwd: "/proj/ws",
    accept: "",
    files: [],
    updatedAt: 1000,
    touched: ["app/src/x.ts", "api/src/y.ts"],
    messages: [{ role: "system", content: "sys" }],
  });

  const resumed = await latestSession("/proj/ws");

  expect(resumed?.touched).toEqual(["app/src/x.ts", "api/src/y.ts"]);
});

test("resume preserves assistant reasoningContent (DeepSeek replay)", async () => {
  await saveSession({
    id: "rc",
    cwd: "/proj/rc",
    accept: "",
    files: [],
    updatedAt: 1000,
    messages: [
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: "answer",
        reasoningContent: "step-by-step thinking",
      },
    ],
  });

  const resumed = await latestSession("/proj/rc");

  expect(resumed?.messages[1]?.reasoningContent).toBe("step-by-step thinking");
});

// Each input contains a secret; after redaction the secret must be GONE and a
// [redacted] marker present. `needle` is a recognizable slice of the secret.
const SECRET_CASES: { name: string; input: string; needle: string }[] = [
  {
    name: "OpenAI key",
    input: "key sk-abcdefghijklmnopqrstuvwx",
    needle: "sk-abcdefghij",
  },
  {
    name: "OpenAI project key",
    input: "use sk-proj-abcdefghijklmnopqrst",
    needle: "sk-proj-abcd",
  },
  {
    name: "Stripe live key",
    input: "stripe sk_live_abcdefghijklmnop",
    needle: "sk_live_abcdef",
  },
  {
    name: "GitHub token",
    input: "token ghp_abcdefghijklmnopqrstuvwxyz0123",
    needle: "ghp_abcdefghij",
  },
  {
    name: "GitHub fine-grained PAT",
    input: "github_pat_11ABCDEFG0abcdefghijklmnop",
    needle: "github_pat_11ABC",
  },
  {
    name: "AWS access key id",
    input: "AKIAIOSFODNN7EXAMPLE here",
    needle: "AKIAIOSFODNN7EXAMPLE",
  },
  {
    name: "Google API key",
    input: "AIzaSyA1234567890abcdefghijklmnopqrs",
    needle: "AIzaSyA123456",
  },
  {
    name: "Slack token",
    input: "xoxb-1234567890-abcdefghij",
    needle: "xoxb-1234567890",
  },
  {
    name: "npm token",
    input: "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    needle: "npm_abcdefghij",
  },
  {
    name: "JWT",
    input: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q",
    needle: "eyJhbGciOiJIUzI1",
  },
  {
    name: "Bearer header",
    input: "Authorization: Bearer abcdef123456ghijklmn",
    needle: "abcdef123456ghij",
  },
  {
    name: "env API_KEY",
    input: "export API_KEY=supersecretvalue123",
    needle: "supersecretvalue123",
  },
  {
    name: "AWS secret env",
    input: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI1234567890abcdef",
    needle: "wJalrXUtnFEMI",
  },
  {
    name: "DB password env",
    input: "DB_PASSWORD=hunter2hunter",
    needle: "hunter2hunter",
  },
  {
    name: "quoted json secret",
    input: '"client_secret": "abc123def456ghi"',
    needle: "abc123def456ghi",
  },
  {
    name: "prose password",
    input: "the password: hunter2hunter works",
    needle: "hunter2hunter",
  },
  {
    name: "connection string",
    input: "postgres://user:hunter2pass@db:5432/app",
    needle: "hunter2pass",
  },
  {
    name: "private key block",
    input:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nsecretmaterial\n-----END RSA PRIVATE KEY-----",
    needle: "secretmaterial",
  },
];

for (const { name, input, needle } of SECRET_CASES) {
  test(`redactText scrubs: ${name}`, () => {
    const out = redactText(input);

    expect(out).not.toContain(needle);
    expect(out).toContain("[redacted]");
  });
}

// False-positive guards: ordinary code/prose must pass through UNCHANGED so the
// saved transcript (and resumed context) isn't corrupted.
const KEEP_CASES = [
  "password: string", // a TS type annotation, not a secret
  "const token: number = 5;",
  "interface ICreds { secret: string; token: string }",
  "function getPassword(): string { return read(); }",
  "the meeting password will be shared verbally",
  "fetch('http://localhost:8080/api/health')",
  "const apiKey = getApiKey();",
];

for (const input of KEEP_CASES) {
  test(`redactText leaves ordinary code/prose alone: ${input.slice(0, 32)}`, () => {
    expect(redactText(input)).toBe(input);
  });
}

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

test("redaction cache never serves a stale result for an edited message", async () => {
  // Messages are redacted through a per-object cache (saves re-ran 13 regexes
  // over the WHOLE transcript every turn). The cache must revalidate against
  // the content field: an in-place edit that introduces a NEW secret has to be
  // re-redacted — a stale hit here would leak it to disk.
  const secretA = `sk-${"a1B2c3D4".repeat(3)}`;
  const secretB = `sk-${"z9Y8x7W6".repeat(3)}`;
  const message = { role: "user" as const, content: `first ${secretA}` };
  const record = {
    id: "redact-cache",
    cwd: "/proj/r",
    accept: "",
    files: ["**/*"],
    updatedAt: 1000,
    messages: [message],
  };

  await saveSession(record);

  const first = await latestSession("/proj/r");

  expect(JSON.stringify(first)).not.toContain(secretA);

  // Same object identity, mutated content — the cache must NOT reuse the old
  // redaction.
  message.content = `second ${secretB}`;
  record.updatedAt = 2000;
  await saveSession(record);

  const second = await latestSession("/proj/r");

  expect(JSON.stringify(second)).not.toContain(secretB);
  expect(JSON.stringify(second)).toContain("second");

  // Unchanged message on a THIRD save still round-trips correctly (cache hit).
  record.updatedAt = 3000;
  await saveSession(record);

  const third = await latestSession("/proj/r");

  expect(JSON.stringify(third)).not.toContain(secretB);
  expect(JSON.stringify(third)).toContain("second");
});
