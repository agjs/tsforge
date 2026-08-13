import { test, expect, describe } from "bun:test";

import {
  runRememberSlashCommand,
  type IRememberTarget,
} from "../src/cli/memory-command";

function fakeSession(opts: {
  bankId: string | null;
  remember: (text: string) => Promise<boolean>;
}): IRememberTarget {
  return {
    decisionMemoryBankId: () => opts.bankId,
    rememberDecision: opts.remember,
  };
}

describe("runRememberSlashCommand", () => {
  test("requires non-empty text", async () => {
    const lines: string[] = [];
    let called = false;

    await runRememberSlashCommand(
      fakeSession({
        bankId: "tsforge:dreamdata",
        remember: async () => {
          called = true;

          return true;
        },
      }),
      "   ",
      (t) => lines.push(t)
    );

    expect(called).toBe(false);
    expect(lines.join("")).toContain("usage: /remember");
  });

  test("refuses when memory is not configured", async () => {
    const lines: string[] = [];

    await runRememberSlashCommand(
      fakeSession({
        bankId: null,
        remember: async () => true,
      }),
      "Prefer package-follow gates",
      (t) => lines.push(t)
    );

    expect(lines.join("")).toContain("not configured");
  });

  test("retains curated text and confirms the bank", async () => {
    const lines: string[] = [];
    let seen = "";

    await runRememberSlashCommand(
      fakeSession({
        bankId: "tsforge:dreamdata",
        remember: async (text) => {
          seen = text;

          return true;
        },
      }),
      "Company FK is a native select",
      (t) => lines.push(t)
    );

    expect(seen).toBe("Company FK is a native select");
    expect(lines.join("")).toContain("remembered in bank tsforge:dreamdata");
  });
});
