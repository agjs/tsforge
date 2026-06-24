import { describe, test, expect } from "bun:test";
import {
  buildChatSystem,
  buildSystemPrompt,
  buildTddGuidance,
} from "../src/loop/prompt";
import { resolveConventions } from "../src/infer-rules/conventions";

const bare = resolveConventions({ interfaces: "bare-pascal-case" });
const iprefix = resolveConventions({ interfaces: "i-prefix" });
const off = resolveConventions({ interfaces: "off" });

describe("system prompt reflects interface convention", () => {
  test("i-prefix tells the model to use the I prefix", () => {
    const p = buildSystemPrompt(false, undefined, iprefix);

    expect(p).toContain("`I`-prefixed");
    expect(p).not.toContain("NO `I` prefix");
  });

  test("bare-pascal-case: no stale I-prefix instruction", () => {
    const p = buildSystemPrompt(false, undefined, bare);

    expect(p).toContain("PascalCase with NO `I` prefix");
    expect(p).not.toContain("interfaces are `I`-prefixed");
  });

  test("off: prompt makes no interface-naming claim at all", () => {
    const p = buildSystemPrompt(false, undefined, off);

    expect(p).not.toContain("`I`-prefixed");
    expect(p).not.toContain("NO `I` prefix");
  });

  test("safety rules are unconditional regardless of naming", () => {
    for (const c of [iprefix, bare, off]) {
      const p = buildSystemPrompt(false, undefined, c);

      expect(p).toContain("no `any` and no `as`");
      expect(p).toContain("complexity at 20");
    }
  });
});

describe("chat prompt reflects interface convention", () => {
  test("bare-pascal-case removes I-prefix from the chat prompt", () => {
    expect(buildChatSystem(bare)).toContain("PascalCase with NO `I` prefix");
    expect(buildChatSystem(bare)).not.toContain("`I`-prefixed interfaces");
  });
});

describe("TDD guidance reflects test layout", () => {
  test("co-located vs mirrored phrasing", () => {
    expect(
      buildTddGuidance(resolveConventions({ tests: "co-located" }))
    ).toContain("co-located `*.test.ts` sibling");
    expect(
      buildTddGuidance(resolveConventions({ tests: "mirrored" }))
    ).toContain("mirrored `tests/` file");
  });
});

describe("build prompt steers away from branded IDs (F22/F26 — always-on prevention)", () => {
  test("the strict-rules line says use a plain alias for IDs, not branded types", () => {
    const p = buildSystemPrompt(false, undefined, iprefix);

    expect(p).toContain("branded");
    expect(p).toContain("type UserId = string");
  });
});
