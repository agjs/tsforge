import { test, expect } from "bun:test";
import {
  detectImageProtocol,
  encodeITerm2,
  renderInlineImage,
  makeImageBudget,
} from "../src/render/terminal-image";

test("detectImageProtocol: explicit override wins over everything", () => {
  expect(
    detectImageProtocol({ TSFORGE_IMAGE_PROTOCOL: "iterm2", TMUX: "/tmp/x" })
  ).toBe("iterm2");
  expect(
    detectImageProtocol({
      TSFORGE_IMAGE_PROTOCOL: "off",
      ITERM_SESSION_ID: "w0",
    })
  ).toBe("none");
});

test("detectImageProtocol: iTerm2 via session id or TERM_PROGRAM", () => {
  expect(detectImageProtocol({ ITERM_SESSION_ID: "w0t0p0" })).toBe("iterm2");
  expect(detectImageProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
});

test("detectImageProtocol: tmux and unknown terminals are none", () => {
  expect(
    detectImageProtocol({ TMUX: "/tmp/tmux", ITERM_SESSION_ID: "w0" })
  ).toBe("none");
  expect(detectImageProtocol({ TERM_PROGRAM: "Apple_Terminal" })).toBe("none");
  expect(detectImageProtocol({})).toBe("none");
});

test("encodeITerm2 produces a well-formed OSC-1337 sequence", () => {
  const seq = encodeITerm2("QUJD", { name: "cat.png", widthCells: 40 });

  expect(seq.startsWith("\x1b]1337;File=")).toBe(true);
  expect(seq.endsWith("\x07")).toBe(true);
  expect(seq).toContain("inline=1");
  expect(seq).toContain("width=40");
  expect(seq).toContain("height=auto");
  expect(seq).toContain("preserveAspectRatio=1");
  // name is base64-encoded per the protocol
  expect(seq).toContain(`name=${Buffer.from("cat.png").toString("base64")}`);
  // the payload follows the last colon
  expect(seq).toContain(":QUJD\x07");
});

test("renderInlineImage returns null for an unsupported protocol", () => {
  expect(renderInlineImage("QUJD", "none")).toBeNull();
  expect(renderInlineImage("QUJD", "iterm2")).toContain("inline=1");
});

test("makeImageBudget caps takes", () => {
  const budget = makeImageBudget(2);

  expect(budget.take()).toBe(true);
  expect(budget.take()).toBe(true);
  expect(budget.take()).toBe(false);
  expect(budget.used()).toBe(2);
});
