/**
 * The pane-mode product-plan UX: planner → yellow PLAN card → approve binds,
 * it does not dump JSON and it does not start a second planner run.
 *
 * This is the path the user actually hits (editor pane, rl === null), driven
 * through the same functions the REPL dispatch uses — not an AST grep.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyReplRoute,
  greenfieldOrSend,
  runGreenfieldPlanning,
  stackHasProductPlan,
  PLANNER_AGENT_ID,
  PLANNER_LABEL,
  type IGreenfieldSession,
  type ProductPlanValidation,
} from "../src/cli/repl";
import { Session } from "../src/loop";
import type { ILoopEvent } from "../src/loop";
import type { IProductPlan } from "../src/loop/planning/plan-types";
import { phaserStackAdapter } from "../src/loop/phaser/planning";
import {
  PLANNER_EXAMPLE,
  phaserPlanSchema,
} from "../src/loop/phaser/plan-extension";
import { readPlan, writePlan } from "../src/loop/planning/plan-store";
import { formatPlanProposal } from "../src/loop/worklist/panel";
import { persistPlanDocument } from "../src/loop/worklist";
import { AgentTreeModel, renderAgentTree } from "../src/render/agent-tree";
import { VirtualScreen } from "./helpers/virtual-screen";
import type { IProvider } from "../src/inference";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function phaserDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-phaser-ux-"));

  dirs.push(dir);
  await mkdir(join(dir, ".tsforge"), { recursive: true });
  await writeFile(
    join(dir, ".tsforge", "scaffold.json"),
    JSON.stringify({ archetype: "phaser" })
  );
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "game" }));

  return dir;
}

function silentProvider(): {
  complete: () => Promise<{ content: string; toolCalls: never[] }>;
} {
  return {
    async complete() {
      return { content: "no", toolCalls: [] };
    },
  };
}

async function sessionIn(dir: string): Promise<Session> {
  return Session.create({
    provider: silentProvider(),
    cwd: dir,
    files: ["**/*"],
  });
}

/** Fake IGreenfieldSession — simulates the model calling propose_product_plan
 *  with the fixture plan on the first send, without a live model or the real
 *  turn loop (that path is covered end-to-end by propose-product-plan-tool.test.ts
 *  and the ask_user pause/resume case below). */
function fixtureGreenfieldSession(): IGreenfieldSession {
  let hooks:
    | {
        readonly validate: (raw: unknown) => ProductPlanValidation;
        readonly onProposed: (plan: IProductPlan) => Promise<void>;
      }
    | undefined;

  return {
    setGreenfieldMode(on, h) {
      hooks = on ? h : undefined;
    },
    async send() {
      const result = hooks?.validate(PLANNER_EXAMPLE);

      if (result?.ok === true) {
        await hooks?.onProposed(result.plan);
      }

      return { status: "done", turns: 1 };
    },
  };
}

describe("Phaser greenfield UX — PLAN card, pending plan, approve binds", () => {
  test("presents the yellow PLAN card, not a JSON blob, and sets pendingPlan (pane path, no readline)", async () => {
    const dir = await phaserDir();
    const session = await sessionIn(dir);
    const echoes: string[] = [];
    const events: ILoopEvent[] = [];
    let painted = "";

    session.setOnPlanPresented((plan) => {
      painted = formatPlanProposal(plan, 80, false);
      echoes.push(`\n${painted}\n`);
    });

    await runGreenfieldPlanning(
      dir,
      "add collectible coins",
      (s) => {
        echoes.push(s);
      },
      phaserStackAdapter,
      {
        report: (e) => {
          events.push(e);
        },
        present: (plan) => {
          session.presentHarnessPlan(plan);
        },
      },
      fixtureGreenfieldSession()
    );

    const echoText = echoes.join("");

    expect(echoText).toContain("planning your product first");
    expect(echoText).not.toContain('"slices"');
    expect(echoText).not.toContain("mustRemainTrue");
    expect(echoText).not.toContain("planning cancelled");

    expect(painted).toContain("PLAN");
    expect(painted).toContain("Flap");
    expect(painted).toContain("type approve to build");
    expect(painted).not.toContain('"slices"');
    expect(painted).not.toContain("mustRemainTrue");

    const screen = new VirtualScreen(40, 80);

    screen.feed(`${painted}\n`);
    const vis = screen.text();

    expect(vis).toContain("PLAN");
    expect(vis).toContain("Flap");
    expect(vis).toContain("type approve to build");
    expect(vis).not.toContain('"slices"');

    const pending = session.getPendingPlan();

    expect(pending).not.toBeNull();
    expect(pending?.items.some((i) => i.title === "Flap")).toBe(true);

    const stored = await readPlan(dir, phaserPlanSchema);

    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("draft");
    expect(await stackHasProductPlan(dir, phaserStackAdapter)).toBe(true);

    if (stored === null) {
      return;
    }

    await writePlan(dir, stored.plan, "approved");
    expect((await readPlan(dir, phaserPlanSchema))?.status).toBe("approved");

    const kinds = events.map((e) => e.kind);

    expect(kinds[0]).toBe("agent_spawned");
    expect(kinds[1]).toBe("agent_started");
    expect(kinds).not.toContain("token");
    expect(kinds.at(-1)).toBe("agent_result");
    expect(events[0]?.agentId).toBe(PLANNER_AGENT_ID);
    expect(events[0]?.message).toBe(PLANNER_LABEL);
    expect(events.at(-1)?.passed).toBe(true);

    const tree = new AgentTreeModel();

    for (const event of events) {
      tree.applyEvent(event);
    }

    const treeText = renderAgentTree(tree.rows(), {
      columns: 80,
      frame: 1,
      color: false,
    }).join("\n");

    expect(treeText).toContain(PLANNER_LABEL);
    expect(treeText).toContain("1/1 done");
  });

  test("the bug the user hit: approve with no pending plan in default plan mode re-plans; after present it binds", async () => {
    const dir = await phaserDir();
    const session = await sessionIn(dir);
    const adapters = [phaserStackAdapter];

    // Default REPL: plan mode ON, nothing presented yet.
    // "approve" is a plan-discuss line → greenfieldOrSend → planner AGAIN.
    expect(
      classifyReplRoute("approve", {
        planMode: true,
        planDiscussed: false,
        awaitingAnswer: false,
        hasPendingPlan: false,
      })
    ).toBe("plan-discuss");

    await runGreenfieldPlanning(
      dir,
      "add coins",
      () => undefined,
      phaserStackAdapter,
      {
        report: () => undefined,
        present: (plan) => {
          session.presentHarnessPlan(plan);
        },
      },
      fixtureGreenfieldSession()
    );

    const afterPresent = {
      planMode: true,
      planDiscussed: false,
      awaitingAnswer: false,
      hasPendingPlan: session.getPendingPlan() !== null,
    };

    expect(afterPresent.hasPendingPlan).toBe(true);
    expect(classifyReplRoute("approve", afterPresent)).toBe("plan-approval");

    let planned = 0;
    let sent = 0;

    await greenfieldOrSend(
      dir,
      adapters,
      async (d, s) =>
        session.getPendingPlan() !== null || (await stackHasProductPlan(d, s)),
      async () => {
        planned += 1;
      },
      async () => {
        sent += 1;
      }
    );

    expect(planned).toBe(0);
    expect(sent).toBe(1);

    const pending = session.takePendingPlan();

    expect(pending).not.toBeNull();

    if (pending !== null) {
      persistPlanDocument(dir, pending);
    }

    expect(session.getPendingPlan()).toBeNull();
    expect(await stackHasProductPlan(dir, phaserStackAdapter)).toBe(true);

    // After bind, even another free-text line must NOT start a second planner.
    planned = 0;
    sent = 0;
    await greenfieldOrSend(
      dir,
      adapters,
      async (d, s) =>
        session.getPendingPlan() !== null || (await stackHasProductPlan(d, s)),
      async () => {
        planned += 1;
      },
      async () => {
        sent += 1;
      }
    );

    expect(planned).toBe(0);
    expect(sent).toBe(1);
  });

  test("a first product line on a fresh Phaser dir is intercepted as greenfield planning", async () => {
    const dir = await phaserDir();
    let planned = 0;
    let sent = 0;

    expect(
      classifyReplRoute("add collectible coins", {
        planMode: true,
        planDiscussed: false,
        awaitingAnswer: false,
        hasPendingPlan: false,
      })
    ).toBe("plan-discuss");

    await greenfieldOrSend(
      dir,
      [phaserStackAdapter],
      async (d, s) => stackHasProductPlan(d, s),
      async () => {
        planned += 1;
      },
      async () => {
        sent += 1;
      }
    );

    expect(planned).toBe(1);
    expect(sent).toBe(0);
  });
});

describe("greenfield planning asks the few clarifying questions that matter (real session, real turn loop)", () => {
  test("ask_user pauses mid-planning; the human's answer resumes the SAME session, then propose_product_plan renders the PLAN card", async () => {
    const dir = await phaserDir();
    let turn = 0;

    const provider: IProvider = {
      async complete() {
        turn += 1;

        if (turn === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "ask_user",
                arguments: {
                  question:
                    "Should hitting a pipe end the run, or just bounce?",
                },
              },
            ],
          };
        }

        if (turn === 2) {
          return {
            content: "",
            toolCalls: [
              {
                id: "2",
                name: "propose_product_plan",
                arguments: {
                  product: PLANNER_EXAMPLE.product,
                  slices: PLANNER_EXAMPLE.slices,
                },
              },
            ],
          };
        }

        // A well-behaved model stops calling tools once it's been told to wait
        // for approval — plain text, no tool calls, so the turn yields normally
        // instead of tripping the readonly-spin escalation ladder.
        return { content: "sounds good, let me know!", toolCalls: [] };
      },
    };

    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
      humanPresent: true,
      offerProductPlan: true,
    });

    let painted = "";

    session.setOnPlanPresented((plan) => {
      painted = formatPlanProposal(plan, 80, false);
    });

    const first = await runGreenfieldPlanning(
      dir,
      "a flappy bird clone",
      () => undefined,
      phaserStackAdapter,
      {
        report: () => undefined,
        present: (plan) => {
          session.presentHarnessPlan(plan);
        },
      },
      session
    );

    // Paused on the model's question — nothing presented yet.
    expect(first.status).toBe("responded");
    expect(first.awaitingUser).toContain("bounce");
    expect(painted).toBe("");

    // The human's answer resumes the SAME conversation via the ordinary
    // session.send path (exactly what the REPL's answer-routing calls) — not
    // a second runGreenfieldPlanning call, and not a second Session.
    const second = await session.send("bounce off pipes, no crash");

    // Not another pause — the turn settled after propose_product_plan (a
    // read-only tool: nothing to gate, so it yields "responded" rather than
    // "done", which is reserved for a mutating turn's green gate).
    expect(second.awaitingUser).toBeUndefined();
    expect(second.status).toBe("responded");
    expect(painted).toContain("PLAN");
    expect(painted).toContain("Flap");
    expect(session.getPendingPlan()).not.toBeNull();

    const stored = await readPlan(dir, phaserPlanSchema);

    expect(stored?.status).toBe("draft");
  });
});
