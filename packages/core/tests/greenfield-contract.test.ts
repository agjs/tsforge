import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider, IChatMessage } from "../src/inference";
import {
  negotiateContract,
  parseObjection,
  writeContract,
  contractEnabled,
  greenfieldDir,
} from "../src/loop/greenfield";
import type { IFeature } from "../src/loop/greenfield";

const feature: IFeature = {
  id: "add-todo",
  desc: "add a todo via the input",
  passes: false,
  attempts: 0,
};

/** A generator that emits a fixed proposal, and an evaluator scripted to object
 *  for the first `objectFor` reviews then agree. */
function generator(text: string): IProvider {
  return {
    async complete() {
      return { content: text, toolCalls: [] };
    },
  };
}

function evaluator(objectFor: number): IProvider {
  let calls = 0;

  return {
    async complete() {
      calls += 1;
      const agreed = calls > objectFor;

      return {
        content: JSON.stringify({
          agreed,
          objections: agreed ? "" : `round ${calls}: too vague`,
        }),
        toolCalls: [],
      };
    },
  };
}

describe("contractEnabled (env-gated, off by default)", () => {
  const saved = process.env.TSFORGE_CONTRACT;

  afterEach(() => {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, "TSFORGE_CONTRACT");
    } else {
      process.env.TSFORGE_CONTRACT = saved;
    }
  });

  test("off unless the flag is a real truthy value", () => {
    Reflect.deleteProperty(process.env, "TSFORGE_CONTRACT");
    expect(contractEnabled()).toBe(false);

    for (const off of ["", "0", "false"]) {
      process.env.TSFORGE_CONTRACT = off;
      expect(contractEnabled()).toBe(false);
    }

    process.env.TSFORGE_CONTRACT = "1";
    expect(contractEnabled()).toBe(true);
  });
});

describe("parseObjection (fail closed)", () => {
  test("agreed only when explicitly true; junk → not agreed", () => {
    expect(parseObjection('{"agreed":true}').agreed).toBe(true);
    expect(parseObjection('{"agreed":false,"objections":"x"}').agreed).toBe(
      false
    );
    expect(parseObjection("not json").agreed).toBe(false);
    expect(parseObjection("not json").notes).toContain("unparseable");
  });
});

describe("negotiateContract", () => {
  test("agrees on the first round when the evaluator accepts", async () => {
    const res = await negotiateContract(
      generator("build an input + handler"),
      evaluator(0),
      feature
    );

    expect(res.agreed).toBe(true);
    expect(res.rounds).toBe(1);
    expect(res.transcript).toHaveLength(2); // one propose + one verdict
  });

  test("loops through objections, then agrees", async () => {
    const res = await negotiateContract(
      generator("build it"),
      evaluator(2),
      feature,
      5
    );

    expect(res.agreed).toBe(true);
    expect(res.rounds).toBe(3); // objected twice, agreed on the third
  });

  test("gives up (not agreed) after maxRounds of objections", async () => {
    const res = await negotiateContract(
      generator("vague"),
      evaluator(99),
      feature,
      3
    );

    expect(res.agreed).toBe(false);
    expect(res.rounds).toBe(3);
  });

  test("a revision shows the generator its OWN previous proposal", async () => {
    // The generator returns a round-numbered proposal and records every prompt.
    const prompts: string[] = [];
    let round = 0;
    const recordingGen: IProvider = {
      async complete(messages) {
        round += 1;
        prompts.push(messages.find((m) => m.role === "user")?.content ?? "");

        return { content: `PROPOSAL_ROUND_${round}`, toolCalls: [] };
      },
    };

    await negotiateContract(recordingGen, evaluator(1), feature, 3);

    // Round 2's prompt must echo round 1's proposal so it can revise, not restart.
    expect(prompts[1]).toContain("PROPOSAL_ROUND_1");
    expect(prompts[1]).toContain("objected");
  });

  test("the evaluator is shown the proposal + feature but never a trace", async () => {
    const seen: IChatMessage[] = [];
    const spyEvaluator: IProvider = {
      async complete(messages) {
        seen.push(...messages);

        return { content: '{"agreed":true}', toolCalls: [] };
      },
    };

    await negotiateContract(
      generator("PROPOSAL_SENTINEL"),
      spyEvaluator,
      feature
    );

    const text = seen.map((m) => m.content).join("\n");

    expect(text).toContain("PROPOSAL_SENTINEL");
    expect(text).toContain(feature.desc);
    // design-rule #2: no trace/reasoning leaks into the evaluator's view
    expect(text.toLowerCase()).not.toContain("reasoning");
    expect(text.toLowerCase()).not.toContain("tool call");
  });
});

describe("writeContract", () => {
  let dir: string;

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a path-like feature id cannot escape the contracts dir", async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-contract-esc-"));
    const evil = {
      id: "../../../README",
      desc: "x",
      passes: false,
      attempts: 0,
    };
    const res = await negotiateContract(generator("p"), evaluator(0), evil);

    await writeContract(dir, evil, res);

    // nothing written outside .tsforge/greenfield/contracts (no clobbered README)
    const escaped = join(dir, "..", "..", "..", "README.md");

    expect(existsSync(escaped)).toBe(false);
    // an unsafe id falls back to a safe name inside the contracts dir
    expect(
      existsSync(join(greenfieldDir(dir), "contracts", "feature.md"))
    ).toBe(true);
  });

  test("persists a transcript under .tsforge/greenfield/contracts", async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-contract-"));
    const res = await negotiateContract(
      generator("the plan"),
      evaluator(0),
      feature
    );

    await writeContract(dir, feature, res);

    const md = await readFile(
      join(greenfieldDir(dir), "contracts", "add-todo.md"),
      "utf8"
    );

    expect(md).toContain("# Contract: add-todo");
    expect(md).toContain("agreed");
    expect(md).toContain("the plan");
  });
});
