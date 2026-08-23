import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phaserHostFromSession } from "../src/cli/phaser-repl-host";
import { persistPlanDocument, normalizePlanDraft } from "../src/loop/worklist";
import { loadPlan } from "../src/loop/worklist/checklist-store";
import { runPhaserBuild } from "../src/loop/phaser/build";
import type { IPhaserHost } from "../src/loop/phaser/build";
import type { PhaserProductPlan } from "../src/loop/phaser/plan-extension";

test("phaserHostFromSession.send forwards the abort signal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-host-"));
  const seen: AbortSignal[] = [];

  try {
    const host = phaserHostFromSession(
      {
        setScope: () => undefined,
        setGate: () => undefined,
        send: (_msg, opts) => {
          if (opts?.signal !== undefined) {
            seen.push(opts.signal);
          }

          return Promise.resolve({ status: "done", turns: 1 });
        },
        getActivePlanId: () => null,
      },
      { cwd: dir }
    );

    const ac = new AbortController();

    await host.send("hi", { signal: ac.signal });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(ac.signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("focusItem binds the matching checklist title", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-host-"));

  try {
    const norm = normalizePlanDraft(
      { goal: "game", items: [{ title: "Flap" }, { title: "Pipes" }] },
      "game"
    );

    expect(norm.ok).toBe(true);

    if (!norm.ok) {
      return;
    }

    const plan = persistPlanDocument(dir, norm.plan);
    const seen: { id: string | null } = { id: null };
    const host = phaserHostFromSession(
      {
        setScope: () => undefined,
        setGate: () => undefined,
        send: () => Promise.resolve({ status: "done", turns: 0 }),
        getActivePlanId: () => plan.id,
      },
      {
        cwd: dir,
        onPlanChanged: (p) => {
          seen.id = p.activeItemId;
        },
      }
    );

    host.focusItem?.("Flap");
    const loaded = loadPlan(dir, plan.id);
    const focusedId = loaded?.items[0]?.id ?? null;

    expect(loaded?.activeItemId).toBe(focusedId);
    expect(loaded?.items[0]?.status).toBe("active");
    expect(seen.id).toBe(focusedId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPhaserBuild parks when the abort signal is already aborted", async () => {
  const ac = new AbortController();

  ac.abort();

  const product: PhaserProductPlan = {
    product: "g",
    slices: [
      {
        entity: {
          id: "Flap",
          desc: "d",
          fields: [],
          relationships: [],
          rules: [],
        },
        ui: { kind: "feature", scene: "World", feature: "flap" },
        verification: {
          mustRemainTrue: ["a"],
          mustNotHappen: ["b"],
          acceptanceCheck: "bun test",
        },
      },
    ],
  };

  const host: IPhaserHost = {
    setScope: () => undefined,
    setGate: () => undefined,
    send: () => Promise.resolve({ status: "done", turns: 1 }),
  };

  const result = await runPhaserBuild({
    cwd: "/tmp",
    plan: product,
    host,
    exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    generate: () =>
      Promise.resolve({ skipped: true, argv: null, paths: ["a.ts"] }),
    wire: () => Promise.resolve({ paths: [] }),
    signal: ac.signal,
  });

  expect(result.status).toBe("parked");
  expect(result.parked).toBe("Flap");
});
