import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack } from "../src/stack-detection";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-stack-"));
}

test("react project: detects react + react-dom, confidence certain, includes react pack", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "react-app",
      dependencies: {
        react: "^18.0.0",
        "react-dom": "^18.0.0",
      },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    expect(profile.packs).toContain("generic-ts");
    expect(profile.packs).toContain("react");
    expect(profile.confidence).toBe("certain");
    expect(profile.name).toContain("react");
    expect(profile.reason.toLowerCase()).toContain("react");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("drizzle + elysia project: detects backend stack, confidence certain", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "backend-app",
      dependencies: {
        "drizzle-orm": "^0.28.0",
        elysia: "^0.6.0",
      },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    expect(profile.packs).toContain("generic-ts");
    expect(profile.packs).toContain("drizzle");
    expect(profile.packs).toContain("elysia");
    expect(profile.confidence).toBe("certain");
    expect(profile.name).toContain("drizzle");
    expect(profile.name).toContain("elysia");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project with vitest in devDeps: detects test-conventions pack", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "test-app",
      dependencies: {
        react: "^18.0.0",
      },
      devDependencies: {
        vitest: "^0.34.0",
      },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    expect(profile.packs).toContain("test-conventions");
    expect(profile.confidence).toBe("certain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project with bullmq: detects bullmq pack from anyDeps", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "queue-app",
      devDependencies: {
        bullmq: "^1.0.0",
      },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    expect(profile.packs).toContain("bullmq");
    expect(profile.confidence).toBe("certain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no package.json: defaults to generic-ts only, confidence guess", async () => {
  const dir = await tempDir();

  try {
    const profile = await detectStack(dir);

    expect(profile.packs).toEqual(["generic-ts"]);
    expect(profile.confidence).toBe("guess");
    expect(profile.name).toBe("generic");
    expect(profile.reason).toContain("no package.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed package.json: tolerates invalid JSON, defaults to generic, confidence guess", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), "{ not valid json }");

    const profile = await detectStack(dir);

    expect(profile.packs).toEqual(["generic-ts"]);
    expect(profile.confidence).toBe("guess");
    expect(profile.name).toBe("generic");
    expect(profile.reason).toContain("invalid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("react + tanstack-query: both packs enabled, combined name", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "spa-app",
      dependencies: {
        react: "^18.0.0",
        "react-dom": "^18.0.0",
        "@tanstack/react-query": "^4.0.0",
      },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    expect(profile.packs).toContain("react");
    expect(profile.packs).toContain("tanstack-query");
    expect(profile.packs).toContain("generic-ts");
    expect(profile.name).toContain("react");
    expect(profile.name).toContain("tanstack-query");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file-existence check: vitest.config.ts enables test-conventions pack", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "file-based-test",
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    await writeFile(join(dir, "vitest.config.ts"), "export default {};");

    const profile = await detectStack(dir);

    expect(profile.packs).toContain("test-conventions");
    expect(profile.confidence).toBe("likely");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("always-on packs: generic-ts, env-access, module-boundaries, code-flow, comment-hygiene, security always present", async () => {
  const dir = await tempDir();

  try {
    const pkg = { name: "simple" };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    expect(profile.packs).toContain("generic-ts");
    expect(profile.packs).toContain("env-access");
    expect(profile.packs).toContain("module-boundaries");
    expect(profile.packs).toContain("code-flow");
    expect(profile.packs).toContain("comment-hygiene");
    expect(profile.packs).toContain("security");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pack order: always-on packs first (deterministic), then framework/library packs", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "ordered-app",
      dependencies: {
        react: "^18.0.0",
        "react-dom": "^18.0.0",
      },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    // Always-on packs come first
    const alwaysOnPacks = [
      "generic-ts",
      "env-access",
      "module-boundaries",
      "code-flow",
      "comment-hygiene",
      "security",
    ];
    const lastAlwaysOnIndex = Math.max(
      ...alwaysOnPacks
        .map((p) => profile.packs.indexOf(p))
        .filter((i) => i !== -1)
    );
    const firstFrameworkIndex = profile.packs.includes("react")
      ? profile.packs.indexOf("react")
      : 999;

    expect(lastAlwaysOnIndex).toBeLessThan(firstFrameworkIndex);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("jwt-cookies pack: detects jsonwebtoken or jose in deps", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "auth-app",
      dependencies: {
        jsonwebtoken: "^9.0.0",
      },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    expect(profile.packs).toContain("jwt-cookies");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("oauth-security pack: detects arctic, openid-client, or passport", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "oauth-app",
      dependencies: {
        arctic: "^1.0.0",
      },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    expect(profile.packs).toContain("oauth-security");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("i18n-keys pack: detects i18next or react-i18next", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "i18n-app",
      dependencies: {
        "react-i18next": "^12.0.0",
      },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    expect(profile.packs).toContain("i18n-keys");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reason field: human-readable explanation of matched signals", async () => {
  const dir = await tempDir();

  try {
    const pkg = {
      name: "explained-app",
      dependencies: {
        react: "^18.0.0",
        "react-dom": "^18.0.0",
        "@tanstack/react-query": "^4.0.0",
      },
    };

    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));

    const profile = await detectStack(dir);

    expect(profile.reason).toBeTruthy();
    expect(profile.reason.length).toBeGreaterThan(0);
    // Should mention detected deps
    expect(profile.reason.toLowerCase()).toContain("react");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
