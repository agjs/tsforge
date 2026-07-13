import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyScaffold } from "../src/scaffold/configure";
import { answersToPlan } from "../src/scaffold/plan";
import { parseManifest } from "../src/scaffold/boringstack-manifest";
import type { IScaffoldFs, IScaffoldRunner } from "../src/scaffold/io";
import type { IShellRun } from "../src/lib/fs/process";

const MANIFEST = parseManifest(
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
      "utf8"
    )
  )
);

function ok(): IShellRun {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
}

/** In-memory fs seeded with a map of path→content. Records writes. */
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

function recorder(): {
  run: IScaffoldRunner;
  calls: readonly string[][];
} {
  const calls: string[][] = [];

  const run: IScaffoldRunner = (_cwd, argv) => {
    calls.push([...argv]);

    return Promise.resolve(ok());
  };

  return { run, calls };
}

const DIR = "/tmp/proj";

describe("applyScaffold — drives boringstack's own scripts", () => {
  test("runs rename-project.sh with the rename args, then setup.sh", async () => {
    const plan = answersToPlan(MANIFEST, {
      archetype: "boringstack",
      stack: "dev",
      values: { project: "acme", ghcrOwner: "acme-corp", domain: "acme.com" },
    });
    const { run, calls } = recorder();
    const { fs } = memFs({
      [`${DIR}/infra/compose/compose/.env.example`]:
        "STACK=dev\nWITH_OBSERVABILITY=1\n",
    });

    await applyScaffold(DIR, MANIFEST, plan, { run, fs });

    const rename = calls.find((c) => c.join(" ").includes("rename-project.sh"));
    const setup = calls.find((c) => c.join(" ").includes("setup.sh"));

    expect(rename).toBeDefined();
    expect(rename).toEqual([
      "bash",
      "scripts/rename-project.sh",
      "acme",
      "acme-corp",
      "acme.com",
    ]);
    // setup.sh bootstraps compose/.env; must run WITHOUT --up (boot is separate)
    expect(setup).toEqual(["bash", "setup.sh"]);
  });
});

describe("applyScaffold — writes env edits to the right files", () => {
  test("infra toggles → compose/.env (seeded from .example); app features → api.dev.env", async () => {
    const plan = answersToPlan(MANIFEST, {
      archetype: "boringstack",
      stack: "dev",
      values: { WITH_OBSERVABILITY: "0", EMAIL_PROVIDER: "resend" },
    });
    const { run } = recorder();
    const { fs, store } = memFs({
      [`${DIR}/infra/compose/compose/.env.example`]:
        "STACK=dev\nWITH_OBSERVABILITY=1\nEMAIL_PROVIDER=cloudflare\n",
    });

    await applyScaffold(DIR, MANIFEST, plan, { run, fs });

    const compose = store.get(`${DIR}/infra/compose/compose/.env`) ?? "";

    expect(compose).toContain("WITH_OBSERVABILITY=0");
    expect(compose).toContain("STACK=dev");

    const apiEnv = store.get(`${DIR}/infra/compose/compose/api.dev.env`) ?? "";

    expect(apiEnv).toContain("EMAIL_PROVIDER=resend");
  });
});

describe("applyScaffold — generated secrets", () => {
  test("fills generate-spec secrets with a real value, redacted in the summary", async () => {
    const plan = answersToPlan(MANIFEST, {
      archetype: "boringstack",
      stack: "prod",
      values: {},
    });
    const { run } = recorder();
    const { fs, store } = memFs({
      [`${DIR}/infra/compose/compose/.env.example`]: "STACK=dev\n",
    });

    const result = await applyScaffold(DIR, MANIFEST, plan, { run, fs });

    const compose = store.get(`${DIR}/infra/compose/compose/.env`) ?? "";
    const jwtLine = compose
      .split("\n")
      .find((l) => l.startsWith("JWT_SECRET="));

    expect(jwtLine).toBeDefined();
    // a real generated value was written (not the empty plan placeholder)
    expect((jwtLine ?? "").length).toBeGreaterThan("JWT_SECRET=".length + 20);

    // …but the summary never leaks the value
    const joined = result.summary.join("\n");

    expect(joined).toContain("JWT_SECRET");
    expect(joined).not.toContain((jwtLine ?? "").split("=")[1] ?? "NOPE");
  });
});

describe("applyScaffold — astro archetype", () => {
  test("no rename/setup/env writes for the static site", async () => {
    const plan = answersToPlan(MANIFEST, {
      archetype: "astro",
      stack: "dev",
      values: {},
    });
    const { run, calls } = recorder();
    const { fs } = memFs();

    await applyScaffold(DIR, MANIFEST, plan, { run, fs });

    expect(calls).toEqual([]);
  });
});

describe("applyScaffold — initial superuser", () => {
  test("an initial superuser is written to compose/.env (password redacted in summary)", async () => {
    const plan = answersToPlan(MANIFEST, {
      archetype: "boringstack",
      stack: "dev",
      values: { project: "acme", ghcrOwner: "acme-corp", domain: "acme.com" },
      superuser: { email: "admin@acme.com", password: "hunter2-hunter2" },
    });
    const { run } = recorder();
    const { fs, store } = memFs({
      [`${DIR}/infra/compose/compose/.env.example`]: "STACK=dev\n",
    });

    let port = 40000;
    const result = await applyScaffold(DIR, MANIFEST, plan, {
      run,
      fs,
      allocatePort: () => Promise.resolve(port++),
    });

    const compose = store.get(`${DIR}/infra/compose/compose/.env`) ?? "";

    expect(compose).toContain("SUPERUSER_EMAIL=admin@acme.com");
    expect(compose).toContain("SUPERUSER_PASSWORD=hunter2-hunter2");
    // Browser-facing links (email verification) must target the project's DYNAMIC
    // UI port, not the hardcoded default 7331. Ports allocate in PORT_ENV_KEYS order
    // from 40000, so UI_HOST_PORT (4th) is 40003.
    expect(compose).toContain("UI_HOST_PORT=40003");
    expect(compose).toContain("API_DEV_FRONTEND_URL=http://localhost:40003");
    // The password must NEVER appear in the (logged) summary — only the key.
    expect(result.summary.join("\n")).toContain(
      "SUPERUSER_EMAIL=admin@acme.com"
    );
    expect(result.summary.join("\n")).not.toContain("hunter2-hunter2");
  });

  test("no superuser fields are written when none was provided", async () => {
    const plan = answersToPlan(MANIFEST, {
      archetype: "boringstack",
      stack: "dev",
      values: { project: "acme", ghcrOwner: "acme-corp", domain: "acme.com" },
    });
    const { run } = recorder();
    const { fs, store } = memFs({
      [`${DIR}/infra/compose/compose/.env.example`]: "STACK=dev\n",
    });

    let port = 41000;

    await applyScaffold(DIR, MANIFEST, plan, {
      run,
      fs,
      allocatePort: () => Promise.resolve(port++),
    });

    const compose = store.get(`${DIR}/infra/compose/compose/.env`) ?? "";

    expect(compose).not.toContain("SUPERUSER_EMAIL");
    expect(compose).not.toContain("SUPERUSER_PASSWORD");
  });
});
