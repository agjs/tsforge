import { test, expect, afterEach } from "bun:test";
import {
  resolveGithubCapability,
  type ICapabilityDeps,
} from "../src/loop/tools/github-ops";

interface IRun {
  exitCode?: number;
  throws?: boolean;
}

function caps(opts: { whichGh?: string | null; auth?: IRun }): ICapabilityDeps {
  return {
    which: () => opts.whichGh ?? null,
    run: async () => {
      if (opts.auth?.throws === true) {
        throw new Error("spawn failed");
      }

      return {
        stdout: "",
        stderr: "",
        exitCode: opts.auth?.exitCode ?? 0,
        timedOut: false,
      };
    },
  };
}

afterEach(() => {
  delete process.env.TSFORGE_NO_GITHUB;
});

test("on when gh is installed and authenticated", async () => {
  const on = await resolveGithubCapability(
    caps({ whichGh: "/usr/bin/gh", auth: { exitCode: 0 } })
  );

  expect(on).toBe(true);
});

test("off when gh is not installed", async () => {
  const on = await resolveGithubCapability(caps({ whichGh: null }));

  expect(on).toBe(false);
});

test("off when gh is present but not authenticated", async () => {
  const on = await resolveGithubCapability(
    caps({ whichGh: "/usr/bin/gh", auth: { exitCode: 1 } })
  );

  expect(on).toBe(false);
});

test("off when the TSFORGE_NO_GITHUB kill-switch is set", async () => {
  process.env.TSFORGE_NO_GITHUB = "1";

  const on = await resolveGithubCapability(
    caps({ whichGh: "/usr/bin/gh", auth: { exitCode: 0 } })
  );

  expect(on).toBe(false);
});

test("fails closed (off) when auth detection throws", async () => {
  const on = await resolveGithubCapability(
    caps({ whichGh: "/usr/bin/gh", auth: { throws: true } })
  );

  expect(on).toBe(false);
});
