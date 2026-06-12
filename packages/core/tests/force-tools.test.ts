import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-force-"));

  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("forced-tools: gated turns run required; yield_status ends the turn cleanly", async () => {
  await withDir(async (dir) => {
    const choices: (string | undefined)[] = [];
    let calls = 0;
    const provider: IProvider = {
      async complete(_messages, opts) {
        choices.push(opts?.toolChoice);
        calls += 1;

        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return {
          content: "",
          toolCalls: [
            {
              id: "2",
              name: "yield_status",
              arguments: { summary: "created x.ts as requested" },
            },
          ],
        };
      },
    };
    const events: { kind: string; message: string }[] = [];
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
      forceTools: true,
      report: (e) => events.push({ kind: e.kind, message: e.message }),
    });
    const result = await session.send("create x.ts");

    expect(result.status).toBe("done");
    expect(existsSync(join(dir, "x.ts"))).toBe(true);
    // Every gated turn was grammar-constrained.
    expect(choices.every((c) => c === "required")).toBe(true);
    // The yield summary surfaced as the reply.
    expect(
      events.some(
        (e) => e.kind === "message" && e.message.includes("created x.ts")
      )
    ).toBe(true);
    // No dangling tool_call: the yield got a tool result message.
    expect(
      session.messages.some(
        (m) => m.role === "tool" && m.content === "(turn ended)"
      )
    ).toBe(true);
  });
});

test("forced-tools: conversational (no gate) sends stay tool_choice auto", async () => {
  await withDir(async (dir) => {
    const choices: (string | undefined)[] = [];
    const provider: IProvider = {
      async complete(_messages, opts) {
        choices.push(opts?.toolChoice);

        return { content: "an answer", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      forceTools: true,
    });
    const result = await session.send("what is this repo?");

    expect(result.status).toBe("responded");
    expect(choices).toEqual(["auto"]);
  });
});

test("yield_status is offered only when forced-tools is on", async () => {
  await withDir(async (dir) => {
    const offered: string[][] = [];
    const provider: IProvider = {
      async complete(_messages, opts) {
        offered.push(
          (opts?.tools ?? []).map(
            (t) => (t as { function: { name: string } }).function.name
          )
        );

        return { content: "ok", toolCalls: [] };
      },
    };
    const on = await Session.create({ provider, cwd: dir, forceTools: true });

    await on.send("hi");
    expect(offered.at(-1)).toContain("yield_status");

    const off = await Session.create({ provider, cwd: dir });

    await off.send("hi");
    expect(offered.at(-1)).not.toContain("yield_status");
  });
});
