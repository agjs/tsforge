import { test, expect } from "bun:test";
import {
  addModel,
  addModelFields,
  buildSettings,
  draftToEntry,
  nextModelName,
  oneLine,
  renderMenu,
  type IConfigDeps,
  type ISetting,
} from "../src/cli/config-menu";
import { formatMenuRows, type IMenuRowData } from "../src/render/inline-menu";
import type { IModelsConfig } from "../src/models-config";

const CFG: IModelsConfig = {
  active: "b",
  models: {
    a: { baseUrl: "http://a/v1", model: "m-a" },
    b: { baseUrl: "http://b/v1", model: "m-b" },
    c: { baseUrl: "http://c/v1", model: "m-c" },
  },
};

// ── pure helpers ─────────────────────────────────────────────────────────────

test("addModelFields: name/baseUrl/model required; apiKey masked + optional", () => {
  const f = Object.fromEntries(addModelFields().map((x) => [x.key, x]));

  expect(Object.keys(f)).toEqual(["name", "baseUrl", "model", "apiKey"]);
  expect(f.name?.validate?.("")).toBe("Name is required");
  expect(f.name?.validate?.("x")).toBeNull();
  expect(f.baseUrl?.default).toBe("http://localhost:8000/v1");
  expect(f.apiKey?.mask).toBe(true);
  expect(f.apiKey?.validate).toBeUndefined();
});

test("draftToEntry trims and omits an empty apiKey", () => {
  expect(
    draftToEntry({ name: " x ", baseUrl: " u ", model: " m ", apiKey: "  " })
  ).toEqual({ name: "x", entry: { baseUrl: "u", model: "m" } });
  expect(
    draftToEntry({ name: "x", baseUrl: "u", model: "m", apiKey: " k " }).entry
      .apiKey
  ).toBe("k");
});

test("addModel adds + activates without mutating the input", () => {
  const next = addModel(CFG, "d", { baseUrl: "http://d/v1", model: "m-d" });

  expect(next.active).toBe("d");
  expect(Object.keys(next.models)).toEqual(["a", "b", "c", "d"]);
  expect(Object.keys(CFG.models)).toEqual(["a", "b", "c"]); // untouched
});

test("nextModelName cycles and wraps; unknown → first", () => {
  expect(nextModelName(CFG, "a")).toBe("b");
  expect(nextModelName(CFG, "c")).toBe("a"); // wrap
  expect(nextModelName(CFG, "zzz")).toBe("a"); // unknown → first
});

// ── settings list (against fake deps, no disk) ───────────────────────────────

function fakeDeps(): { deps: IConfigDeps; state: Record<string, string> } {
  const state: Record<string, string> = {
    mode: "plan",
    gate: "",
    scope: "entire workspace",
  };
  const env: Record<string, string | undefined> = {};

  const deps: IConfigDeps = {
    color: false,
    suspend: () => undefined,
    resume: () => undefined,
    reconfigure: () => undefined,
    currentModelName: () => "qwen-local",
    onModelChange: () => undefined,
    currentMode: () => state.mode ?? "plan",
    setMode: (id) => {
      state.mode = id;
    },
    getGate: () => state.gate ?? "",
    setGate: (cmd) => {
      state.gate = cmd;
    },
    getScope: () => state.scope ?? "",
    setScope: (globs) => {
      state.scope = globs;
    },
    getEnv: (name) => env[name],
    setEnv: (name, value) => {
      env[name] = value;
    },
  };

  return { deps, state };
}

function byId(settings: ISetting[], id: string): ISetting {
  const s = settings.find((x) => x.id === id);

  if (s === undefined) {
    throw new Error(`no setting ${id}`);
  }

  return s;
}

test("every setting has a group, label, and a non-empty description (self-documenting)", () => {
  const { deps } = fakeDeps();
  const settings = buildSettings(deps);

  expect(settings.length).toBeGreaterThanOrEqual(6);

  for (const s of settings) {
    expect(s.group.length).toBeGreaterThan(0);
    expect(s.label.length).toBeGreaterThan(0);
    expect(s.describe.length).toBeGreaterThan(0);
    expect(typeof s.read()).toBe("string");
  }
});

test("mode setting reads + toggles plan↔normal", () => {
  const { deps, state } = fakeDeps();
  const mode = byId(buildSettings(deps), "mode");

  expect(mode.read()).toBe("plan");
  void mode.activate?.();
  expect(state.mode).toBe("normal");
});

test("gate + scope settings read live and apply typed text", async () => {
  const { deps, state } = fakeDeps();
  const settings = buildSettings(deps);

  expect(byId(settings, "gate").read()).toBe("(none)");
  await byId(settings, "gate").applyText?.({ gate: " bun test " });
  expect(state.gate).toBe("bun test");

  await byId(settings, "scope").applyText?.({ scope: "src/**" });
  expect(state.scope).toBe("src/**");
});

test("web tools toggle flips the env flag on/off", () => {
  const { deps } = fakeDeps();
  const web = byId(buildSettings(deps), "tools.web");

  expect(web.read()).toBe("off");
  void web.activate?.();
  expect(web.read()).toBe("on");
  expect(deps.getEnv("TSFORGE_WEB")).toBe("1");
  void web.activate?.();
  expect(web.read()).toBe("off");
});

test("TDD toggle is on by default and flips to off", () => {
  const { deps } = fakeDeps();
  const tdd = byId(buildSettings(deps), "tools.tdd");

  expect(tdd.read()).toBe("on"); // default (env unset)
  void tdd.activate?.();
  expect(tdd.read()).toBe("off");
  expect(deps.getEnv("TSFORGE_TDD")).toBe("0");
});

test("only human choices are in /config — no eval/kill-switch knobs", () => {
  const { deps } = fakeDeps();
  const ids = buildSettings(deps).map((s) => s.id);

  // nobody disables code nav / git context / the script tool interactively, and
  // the update check always runs — these are env-only (eval/CI), never settings.
  expect(ids).not.toContain("tools.nav");
  expect(ids).not.toContain("tools.git");
  expect(ids).not.toContain("tools.script");
  expect(ids).not.toContain("tools.updateCheck");
  // the genuine human toggles stay.
  expect(ids).toContain("tools.web");
  expect(ids).toContain("tools.tdd");
});

test("renderMenu shows EVERY setting's description (config screen is the docs)", () => {
  const { deps } = fakeDeps();
  const settings = buildSettings(deps);
  const screen = renderMenu(settings, 0, false);

  for (const s of settings) {
    expect(screen).toContain(s.describe);
  }
});

test("formatMenuRows: 12 rows with cursor at index 9 shows scroll + windowed slice + describe + footer", () => {
  const rows: IMenuRowData[] = Array.from(
    { length: 12 },
    (_, i) => ({
      id: `row-${i}`,
      label: `Setting ${i}`,
      hint: `hint-${i}`,
      describe: `Description for setting ${i}`,
    })
  );

  const lines = formatMenuRows(rows, 9, 80, false);
  const block = lines.join("\n");

  // Should have scroll indicator for rows above (↑ N more).
  expect(block).toContain("↑");
  // Should show the windowed slice around cursor 9 (≤ 8 visible rows).
  expect(block).toContain("Setting 9");
  // Should have the selected row's full description.
  expect(block).toContain("Description for setting 9");
  // Should have the footer hint.
  expect(block).toContain("↑/↓ move");
  // Should have the divider.
  expect(block).toContain("────");
  // Rows above the window should not all be shown (if window < 12).
  const rowCount = lines.filter((l) => l.includes("Setting")).length;
  expect(rowCount).toBeLessThanOrEqual(8);
});

test("oneLine truncates long values to one line + collapses whitespace", () => {
  expect(oneLine("short")).toBe("short");
  const big = oneLine("x".repeat(200));

  expect(big.length).toBeLessThanOrEqual(52);
  expect(big.endsWith("\u2026")).toBe(true);
  // a multi-line gate command must never wrap the menu
  expect(oneLine("tsc --noEmit\n  && bun test")).toBe(
    "tsc --noEmit && bun test"
  );
});
