import { describe, expect, test } from "bun:test";
import { sessionRows } from "../src/cli/session-menu";
import type { ISessionRecord } from "../src/session-store";
import type { IChatMessage } from "../src/inference";

function record(id: string, messages: IChatMessage[]): ISessionRecord {
  return {
    id,
    cwd: "/tmp",
    accept: "",
    files: [],
    updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    messages,
  };
}

describe("sessionRows", () => {
  test("maps id, msg count hint, and first-user describe", () => {
    const rows = sessionRows([
      record("abc-1", [
        { role: "user", content: "Build a tiny notes CLI" },
        { role: "assistant", content: "ok" },
      ]),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("abc-1");
    expect(rows[0]?.label).toBe("abc-1");
    expect(rows[0]?.hint).toBe("2 msgs");
    expect(rows[0]?.describe).toBe("Build a tiny notes CLI");
  });

  test("empty session gets a resume hint describe", () => {
    const rows = sessionRows([record("empty", [])]);

    expect(rows[0]?.describe).toContain("resume");
  });
});
