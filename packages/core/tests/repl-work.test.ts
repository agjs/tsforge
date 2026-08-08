import { describe, expect, test } from "bun:test";
import { approvePlan } from "../src/cli/repl-work";

describe("approvePlan", () => {
  test("cancels when no asker is available (non-interactive)", async () => {
    const out: string[] = [];

    await expect(
      approvePlan((s) => out.push(s), "checklist", null)
    ).resolves.toBe("cancel");
    expect(out.join("")).toContain("non-interactive");
  });

  test("uses askApprove callback (pane editor path)", async () => {
    const out: string[] = [];

    await expect(
      approvePlan(
        (s) => out.push(s),
        "- [ ] one\n",
        async () => "approve"
      )
    ).resolves.toBe("approve");
    expect(out.join("")).toContain("Proposed worklist");
    expect(out.join("")).not.toContain("non-interactive");
  });

  test("propagates cancel from asker", async () => {
    await expect(
      approvePlan(
        () => undefined,
        "x",
        async () => "cancel"
      )
    ).resolves.toBe("cancel");
  });
});
