import { describe, expect, test, spyOn } from "bun:test";
import {
  mergeAnswerValues,
  runScaffoldCommand,
} from "../src/scaffold/scaffold-command";
import { type runScaffold } from "../src/scaffold/run-scaffold";
import type { IScaffoldOutcome } from "../src/scaffold";

const STUB_OUTCOME: IScaffoldOutcome = {
  dir: "/tmp/x",
  gateCwd: "/tmp/x",
  gateCommand: "bun run build",
  resolvedSha: "deadbeef",
  booted: false,
  summary: [],
  ports: {},
};

describe("runScaffoldCommand progress wiring", () => {
  test("forwards a scaffold phase to stdout in the standard '  → …' format", async () => {
    const seen: string[] = [];

    // An astro scaffold has no wizard steps, so the command reaches runScaffold
    // directly (no TTY needed). A fake runner fires a phase; assert it hit stdout.
    const fakeRun: typeof runScaffold = (_manifest, _answers, _dest, deps) => {
      deps.onPhase?.("Cloning the project template…");

      return Promise.resolve(STUB_OUTCOME);
    };

    const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      seen.push(String(chunk));

      return true;
    });

    try {
      await runScaffoldCommand(
        ["--dest", "/tmp/hd-cmd-test", "--archetype", "astro"],
        false,
        fakeRun
      );
    } finally {
      spy.mockRestore();
    }

    expect(seen.join("")).toContain("  → Cloning the project template…\n");
  });
});

describe("mergeAnswerValues", () => {
  test("flag values override wizard values for the same key", () => {
    const merged = mergeAnswerValues(
      { WITH_OBSERVABILITY: "1", EMAIL_PROVIDER: "cloudflare" },
      { EMAIL_PROVIDER: "resend" }
    );

    expect(merged.WITH_OBSERVABILITY).toBe("1"); // wizard value kept
    expect(merged.EMAIL_PROVIDER).toBe("resend"); // flag override wins
  });

  test("keys present only in one source are preserved", () => {
    const merged = mergeAnswerValues({ WITH_BULLMQ: "0" }, { project: "acme" });

    expect(merged.WITH_BULLMQ).toBe("0");
    expect(merged.project).toBe("acme");
  });

  test("empty flag set leaves wizard values intact", () => {
    const merged = mergeAnswerValues({ STACK: "dev" }, {});

    expect(merged).toEqual({ STACK: "dev" });
  });
});
