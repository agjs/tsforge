import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpec } from "../src/loop/run-spec";
import type { ISpec } from "../src/spec/types";
import { scripted, runStep, STOP } from "./stub-provider";

function twoTaskSpec(verify: string): ISpec {
  return {
    id: "s",
    title: "t",
    verify,
    tasks: [
      { id: "1", accept: "test -f 1.txt", files: [] },
      { id: "2", accept: "test -f 2.txt", files: [] },
    ],
  };
}

test("runs tasks in order to done, then the whole-spec verify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-spec-"));

  try {
    // task 1: create 1.txt then stop; task 2: create 2.txt then stop.
    const provider = scripted([
      runStep("touch 1.txt"),
      STOP,
      runStep("touch 2.txt"),
      STOP,
    ]);
    const r = await runSpec(twoTaskSpec("true"), dir, provider);

    expect(r.status).toBe("done");
    expect(r.results).toHaveLength(2);
    expect(r.results.every((x) => x.status === "done")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocks on the first task that does not reach done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-spec-"));

  try {
    const r = await runSpec(twoTaskSpec("true"), dir, scripted([STOP]));

    expect(r.status).toBe("blocked");
    expect(r.results).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocks when all tasks pass but the whole-spec verify fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-spec-"));

  try {
    const spec: ISpec = {
      id: "s",
      title: "t",
      verify: "false",
      tasks: [{ id: "1", accept: "test -f 1.txt", files: [] }],
    };
    const r = await runSpec(
      spec,
      dir,
      scripted([runStep("touch 1.txt"), STOP])
    );

    expect(r.status).toBe("blocked");
    expect(r.results[0]?.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
