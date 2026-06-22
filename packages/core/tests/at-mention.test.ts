import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAtPaths,
  resolveAtMentions,
  composeMessage,
} from "../src/loop/prompt/at-mention";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tsforge-at-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "foo.ts"), "export const foo = 1;\n");
  await writeFile(join(dir, "big.ts"), "x".repeat(13_000)); // > mapThresholdChars
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("parseAtPaths: only matches @ at a word boundary, de-duped", () => {
  expect(parseAtPaths("fix @src/foo.ts please")).toEqual(["src/foo.ts"]);
  expect(parseAtPaths("@a.ts and @a.ts again")).toEqual(["a.ts"]);
  expect(parseAtPaths("mail ag@dreamdata.io now")).toEqual([]); // email: no boundary
  expect(parseAtPaths("no mentions here")).toEqual([]);
});

test("resolveAtMentions: strips @ from resolved files, reads their views", async () => {
  const { text, views } = await resolveAtMentions(dir, "explain @src/foo.ts");

  expect(views.map((v) => v.path)).toEqual(["src/foo.ts"]);
  expect(text).toBe("explain src/foo.ts"); // @ stripped from the recognized token
});

test("resolveAtMentions: leaves unresolved @-tokens untouched", async () => {
  const { text, views } = await resolveAtMentions(
    dir,
    "see @nope.ts and @Component"
  );

  expect(views).toEqual([]);
  expect(text).toBe("see @nope.ts and @Component");
});

test("composeMessage: inlines small file contents above the cleaned line", async () => {
  const msg = await composeMessage(dir, "explain @src/foo.ts");

  expect(msg).toContain("export const foo = 1;"); // full contents inlined
  expect(msg.endsWith("explain src/foo.ts")).toBe(true);
});

test("composeMessage: large file is rendered as a MAP, not inlined verbatim", async () => {
  const msg = await composeMessage(dir, "look at @big.ts");

  expect(msg).toContain("big.ts ("); // MAP marker: "  big.ts (N lines)"
  expect(msg).toContain("lines)");
  expect(msg).not.toContain("File big.ts:"); // not the inline-contents branch
  expect(msg).not.toContain("x".repeat(13_000)); // raw blob not dumped
});

test("composeMessage: a line with no mentions passes through unchanged", async () => {
  expect(await composeMessage(dir, "just a question")).toBe("just a question");
});
