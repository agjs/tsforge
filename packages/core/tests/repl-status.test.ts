import { test, expect } from "bun:test";
import { resolveChromeStatus } from "../src/cli/repl-status";
import { formatConsoleTitle } from "../src/render/frame/chrome";
import { stripSgr } from "../src/render/frame/ansi-plain";

test("idle lastStatus while busy is working, not ✓", () => {
  const chrome = resolveChromeStatus({
    busy: true,
    lastStatus: "ready",
    activity: "",
  });

  expect(chrome.status).toBe("working");
  expect(chrome.activity).toBe("working");

  const row = stripSgr(
    formatConsoleTitle({
      info: {
        model: "m",
        contextTokens: 0,
        contextWindow: 100,
        turns: 0,
        elapsedMs: 0,
        status: chrome.status,
        scope: "repo",
        mode: "normal",
        activity: chrome.activity,
      },
      cwd: "/tmp",
      cols: 80,
      color: false,
    })
  );

  expect(row).toContain("working");
  expect(row).not.toContain("✓");
});

test("idle when not busy keeps lastStatus", () => {
  const chrome = resolveChromeStatus({
    busy: false,
    lastStatus: "ready",
    activity: "",
  });

  expect(chrome.status).toBe("ready");
  expect(chrome.activity).toBeUndefined();
});
