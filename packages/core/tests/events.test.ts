import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/loop";
import { scripted, runStep, STOP } from "./stub-provider";

test("runTask emits progress events (red → cycle → run → done)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-events-"));

  try {
    const kinds: string[] = [];

    await runTask(
      { id: "1", accept: "test -f 1.txt", files: [] },
      dir,
      scripted([runStep("touch 1.txt"), STOP]),
      { onEvent: (e) => kinds.push(e.kind) }
    );

    expect(kinds).toContain("red");
    expect(kinds).toContain("cycle");
    expect(kinds).toContain("run");
    expect(kinds).toContain("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
