import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootStack } from "../src/scaffold/boot";
import { parseManifest } from "../src/scaffold/boringstack-manifest";
import type { IReadyPoller, IScaffoldRunner } from "../src/scaffold/io";
import type { IShellRun } from "../src/lib/fs/process";

const MANIFEST = parseManifest(
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures/scaffold/scaffold-manifest.json"),
      "utf8"
    )
  )
);

function shell(exitCode = 0, stderr = ""): IScaffoldRunner {
  return (_cwd, _argv) =>
    Promise.resolve<IShellRun>({
      stdout: "",
      stderr,
      exitCode,
      timedOut: false,
    });
}

const DIR = "/tmp/proj";

describe("bootStack", () => {
  test("runs the manifest boot command and polls every health URL", async () => {
    const seen: string[] = [];

    const poll: IReadyPoller = (url) => {
      seen.push(url);

      return Promise.resolve(200);
    };

    const argvs: string[][] = [];

    const run: IScaffoldRunner = (_cwd, argv) => {
      argvs.push([...argv]);

      return Promise.resolve<IShellRun>({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      });
    };

    const result = await bootStack(DIR, MANIFEST, { run, poll });

    expect(result.booted).toBe(true);
    // boot command came from the manifest (bash setup.sh --up)
    expect(argvs[0]?.join(" ")).toContain("setup.sh --up");
    // both health URLs were polled
    expect(seen).toEqual([
      "http://localhost:7331/",
      "http://localhost:7330/swagger/json",
    ]);
  });

  test("not booted when a health URL never answers", async () => {
    const poll: IReadyPoller = (url) =>
      Promise.resolve(url.includes("7330") ? null : 200);

    const result = await bootStack(DIR, MANIFEST, { run: shell(0), poll });

    expect(result.booted).toBe(false);
    expect(
      result.statuses.find((s) => s.url.includes("7330"))?.status
    ).toBeNull();
  });

  test("not booted (and does not poll) when the boot command fails", async () => {
    let polled = false;

    const poll: IReadyPoller = () => {
      polled = true;

      return Promise.resolve(200);
    };

    const result = await bootStack(DIR, MANIFEST, {
      run: shell(1, "compose: no such service"),
      poll,
    });

    expect(result.booted).toBe(false);
    expect(polled).toBe(false);
    expect(result.error).toMatch(/no such service/u);
  });
});

describe("bootStack — health-check failure is an error (Codex P1)", () => {
  test("a timed-out health poll sets `error` (so callers exit non-zero)", async () => {
    const poll: IReadyPoller = (url) =>
      Promise.resolve(url.includes("7330") ? null : 200);

    const result = await bootStack(DIR, MANIFEST, { run: shell(0), poll });

    expect(result.booted).toBe(false);
    expect(result.error).toMatch(/health check failed/iu);
    expect(result.error).toContain("7330");
  });
});
