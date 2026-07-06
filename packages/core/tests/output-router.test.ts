import { test, expect, describe } from "bun:test";
import { OutputRouter } from "../src/cli/output-router";

/** Capture stdout writes made during fn, restoring the real writer after. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));

    return true;
  };

  try {
    fn();
  } finally {
    process.stdout.write = original;
  }

  return chunks.join("");
}

describe("OutputRouter", () => {
  test("routes to stdout when no sinks are installed", () => {
    const router = new OutputRouter();

    const out = captureStdout(() => {
      router.route("plain\n");
    });

    expect(out).toBe("plain\n");
  });

  test("parent sink wins over stdout once installed, and clears back", () => {
    const router = new OutputRouter();
    const parent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.route("to-parent");
    expect(parent).toEqual(["to-parent"]);

    router.setParentSink(null);

    const out = captureStdout(() => {
      router.route("back-to-stdout");
    });

    expect(out).toBe("back-to-stdout");
    expect(parent).toEqual(["to-parent"]); // untouched after clear
  });

  test("an agent's writes go to its own sink, not the parent's", () => {
    const router = new OutputRouter();
    const parent: string[] = [];
    const agent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.setAgentSink("run:explore", (text) => agent.push(text));

    router.route("child-text", "run:explore");
    router.route("parent-text");

    expect(agent).toEqual(["child-text"]);
    expect(parent).toEqual(["parent-text"]);
  });

  test("an agentId with no registered sink falls back to the parent sink", () => {
    const router = new OutputRouter();
    const parent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.route("orphan-child", "run:unknown");

    expect(parent).toEqual(["orphan-child"]);
  });

  test("clearAgentSink removes the route; later writes fall back", () => {
    const router = new OutputRouter();
    const parent: string[] = [];
    const agent: string[] = [];

    router.setParentSink((text) => parent.push(text));
    router.setAgentSink("run:a", (text) => agent.push(text));

    router.route("first", "run:a");
    router.clearAgentSink("run:a");
    router.route("second", "run:a");

    expect(agent).toEqual(["first"]);
    expect(parent).toEqual(["second"]);
  });
});
