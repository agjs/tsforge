import { test, expect, describe } from "bun:test";
import type { IErrorItem } from "../src/validate";
import { gateFeedback } from "../src/loop/feedback";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

describe("focusError filtering (R3)", () => {
  // Create a minimal task and temp files for testing.
  const setupTest = async () => {
    const cwd = join(tmpdir(), `tsforge-focus-test-${Math.random()}`);

    await mkdir(cwd, { recursive: true });

    // Write a dummy file so gateFeedback can read it.
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src/App.tsx"), "export const App = () => null;");

    return { cwd };
  };

  test("focusError filters rendered feedback to only the focused error", async () => {
    const { cwd } = await setupTest();
    const errors: IErrorItem[] = [
      {
        key: "src/App.tsx:1:no-jsx-computation",
        file: "src/App.tsx",
        line: 1,
        rule: "no-jsx-computation",
        message: "JSX computation found",
      },
      {
        key: "src/App.tsx:2:no-restricted-syntax",
        file: "src/App.tsx",
        line: 2,
        rule: "no-restricted-syntax",
        message: "Restricted syntax used",
      },
    ];

    const task = {
      id: "test-1",
      accept: "bun run test",
      files: ["src/**"],
    };

    // Without focusError, both errors are rendered.

    const feedbackFull = await gateFeedback(errors, task, cwd);

    expect(feedbackFull).toContain("JSX computation found");
    expect(feedbackFull).toContain("Restricted syntax used");

    // With focusError set to the first error, only that error is rendered.
    const focusKey = "src/App.tsx:1:no-jsx-computation";

    const feedbackFocused = await gateFeedback(errors, task, cwd, [], focusKey);

    expect(feedbackFocused).toContain("JSX computation found");
    expect(feedbackFocused).not.toContain("Restricted syntax used");
  });

  test("focusError set to non-existent error key renders empty feedback", async () => {
    const { cwd } = await setupTest();
    const errors: IErrorItem[] = [
      {
        key: "src/App.tsx:1:real-error",
        file: "src/App.tsx",
        line: 1,
        rule: "real-error",
        message: "A real error",
      },
    ];

    const task = {
      id: "test-1",
      accept: "bun run test",
      files: ["src/**"],
    };

    // When focusError doesn't match any error, feedback says so.

    const feedback = await gateFeedback(
      errors,
      task,
      cwd,
      [],
      "src/App.tsx:1:non-existent"
    );

    expect(feedback).toContain("no errors matching the focused error key");
  });
});
