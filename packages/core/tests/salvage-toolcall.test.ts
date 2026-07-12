import { test, expect } from "bun:test";
import { salvageToolCalls, salvageFusedToolName } from "../src/inference";

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

// The atlas-spark (NVFP4) form captured live: Qwen3.5-native `<function=NAME>`
// XML, which Atlas's qwen3_coder/hermes parsers don't match, so it leaks into
// content. Same param structure, just a `function=` wrapper on the tool name.
const FUNCTION_SOUP = `I'll create the barrels.

<tool_call>
<function=create>
<parameter=content>
export * from './account.types';
</parameter>
<parameter=file>
src/account/index.ts
</parameter>
</function>
</tool_call>`;

test("salvages the <function=NAME><parameter=..> wrapper form (atlas-spark)", () => {
  const calls = salvageToolCalls(FUNCTION_SOUP);

  expect(calls.length).toBe(1);
  expect(calls[0]?.name).toBe("create");
  expect(calls[0]?.arguments).toEqual({
    content: "export * from './account.types';",
    file: "src/account/index.ts",
  });
});

test("dedupes the SAME call repeated in one response (atlas-spark 4x repeat)", () => {
  // The model emits the identical create several times in one generation.
  const block = `<function=create>
<parameter=file>
src/a.ts
</parameter>
<parameter=content>
export const a = 1;
</parameter>
</function>`;
  const repeated = `${block}\n${block}\n${block}\n${block}`;
  const calls = salvageToolCalls(repeated);

  expect(calls.length).toBe(1);
  expect(calls[0]?.name).toBe("create");
  expect(calls[0]?.arguments).toEqual({
    file: "src/a.ts",
    content: "export const a = 1;",
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

// Captured live 2026-06-23 from aeon-qwen3.6-27b: a STRUCTURED tool_call whose
// `function.name` swallowed the whole XML body (no `<function=>` wrapper, so the
// server parser couldn't split it). It rendered as `edit<parameter=file…`, hit the
// policy as an "unknown tool", and the model looped on it to the stall cap.
test("salvageFusedToolName recovers a structured name that absorbed the parameter XML", () => {
  const fused = salvageFusedToolName(
    "edit\n<parameter=file>src/data/store.ts</parameter>\n" +
      "<parameter=oldString>const x = 1 as any;</parameter>\n" +
      "<parameter=newString>const x = 1;</parameter>",
    ""
  );

  expect(fused?.name).toBe("edit");
  expect(fused?.arguments).toMatchObject({
    file: "src/data/store.ts",
    oldString: "const x = 1 as any;",
    newString: "const x = 1;",
  });
});

test("salvageFusedToolName handles the <function=NAME> wrapper + missing close tag", () => {
  // function= prefix, </function> tail, and the LAST parameter with no </parameter>.
  const fused = salvageFusedToolName(
    "function=create<parameter=file>a.ts</parameter><parameter=content>export const z = 1;</function>",
    ""
  );

  expect(fused?.name).toBe("create");
  expect(fused?.arguments.content).toBe("export const z = 1;");
});

test("salvageFusedToolName leaves a well-formed call and unknown tools alone", () => {
  // A normal call (name + JSON args) is NOT this fused form → null (parsed normally).
  expect(salvageFusedToolName("edit", '{"file":"a.ts"}')).toBeNull();
  // An unknown tool name is never salvaged into a real call.
  expect(
    salvageFusedToolName("frobnicate<parameter=x>1</parameter>", "")
  ).toBeNull();
});

// The Qwen-channel pipe form captured live from qwen3.6-35b-a3b in the CLI:
// `<|read|>{json}` markers vLLM left in content (toolCalls came back empty).
test("salvages the <|toolname|>{json} pipe form", () => {
  const soup =
    'Let me inspect it.\n\n<|read|>{"file": "/agjs/code/ant"}\n\n' +
    '<|run|>{"command": "ls -la"}';
  const calls = salvageToolCalls(soup);

  expect(calls.length).toBe(2);
  expect(calls[0]).toEqual({
    id: undefined,
    name: "read",
    arguments: { file: "/agjs/code/ant" },
  });
  expect(calls[1]?.name).toBe("run");
  expect(calls[1]?.arguments).toEqual({ command: "ls -la" });
});

test("pipe form: string-aware brace scan keeps code containing braces intact", () => {
  const soup =
    '<|create|>{"file": "a.ts", "content": "export function f() { return {x: 1}; }"}';
  const calls = salvageToolCalls(soup);

  expect(calls.length).toBe(1);
  expect(calls[0]?.arguments.content).toBe(
    "export function f() { return {x: 1}; }"
  );
});

test("pipe form: ignores unknown tool names", () => {
  expect(salvageToolCalls('<|think|>{"foo": 1}')).toEqual([]);
});

// The exact malformed output captured live 2026-06-12 from qwen3.6-27b in the
// interactive CLI: a `<parameters>` (plural) wrapper with bare `<key>` tags and
test("<parameters>-block variant with several keys and closing tags", () => {
  const calls = salvageToolCalls(
    "<read>\n<parameters>\n<file>src/a.ts</file>\n</parameters>\n</function>"
  );

  expect(calls).toEqual([
    { id: undefined, name: "read", arguments: { file: "src/a.ts" } },
  ]);
});

test("<parameters>-block variant ignores unknown tools", () => {
  expect(
    salvageToolCalls("<imaginary>\n<parameters>\n<x>\n1\n</parameters>")
  ).toEqual([]);
});
