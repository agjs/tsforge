import { test, expect } from "bun:test";
import { salvageToolCalls } from "../src/inference";

// The exact malformed output captured from a react-board run (the local model
// emitted tool calls as non-standard XML that vLLM left in content).
const SOUP = `Let me first explore the project structure.

<read>
<parameter=file>
src/App.tsx
</parameter>
</function>
</tool_call>
<search>
<parameter=pattern>
addCard|render|App
</parameter>
<parameter=glob>
src/**/*.tsx
</parameter>
</function>
</tool_call>`;

test("salvages malformed <toolname><parameter=..> tool calls from content", () => {
  const calls = salvageToolCalls(SOUP);

  expect(calls.length).toBe(2);
  expect(calls[0]?.name).toBe("read");
  expect(calls[0]?.arguments).toEqual({ file: "src/App.tsx" });
  expect(calls[1]?.name).toBe("search");
  expect(calls[1]?.arguments).toEqual({
    pattern: "addCard|render|App",
    glob: "src/**/*.tsx",
  });
});

test("ignores unknown tag names (no false positives from prose/JSX)", () => {
  // <div>/<section> are not tools; a stray <parameter=> with no known wrapper
  // must not produce a call.
  const notACall =
    "Here is some JSX: <section>\n<parameter=foo>\nbar\n</parameter>\n</section>";

  expect(salvageToolCalls(notACall)).toEqual([]);
});

test("returns nothing for plain prose", () => {
  expect(
    salvageToolCalls("I will now create the file with the functions.")
  ).toEqual([]);
});
