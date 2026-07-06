import { test, expect, describe } from "bun:test";
import { LiveRegion } from "../src/render/live-region";
import { AgentTreeModel, renderAgentTree } from "../src/render/agent-tree";
import { VirtualScreen } from "./helpers/virtual-screen";

/** A capturing terminal double: records every byte written, reports as a TTY. */
function captureTerm(): {
  out: { write: (s: string) => boolean; isTTY: boolean };
  bytes: () => string;
} {
  const chunks: string[] = [];

  return {
    out: {
      isTTY: true,
      write: (s: string): boolean => {
        chunks.push(s);

        return true;
      },
    },
    bytes: (): string => chunks.join(""),
  };
}

/** Replay a captured byte stream onto a grid and return trimmed rows. */
function screenOf(bytes: string, rows = 10, cols = 60): VirtualScreen {
  const screen = new VirtualScreen(rows, cols);

  screen.feed(bytes);

  return screen;
}

describe("LiveRegion + agent tree — the real rendered screen", () => {
  test("repaints in place: the final frame shows, earlier frames leave no ghost", () => {
    const term = captureTerm();
    const live = new LiveRegion(term.out, true);
    const model = new AgentTreeModel();

    model.applyUnit("explore", "pending");
    model.applyUnit("review", "pending");
    live.render(
      renderAgentTree(model.rows(), { columns: 60, frame: 0, color: false })
    );

    model.applyUnit("explore", "start");
    live.render(
      renderAgentTree(model.rows(), { columns: 60, frame: 1, color: false })
    );

    model.applyUnit("explore", "done", { durationMs: 1200, turns: 2 });
    live.render(
      renderAgentTree(model.rows(), { columns: 60, frame: 2, color: false })
    );

    const screen = screenOf(term.bytes());

    // The single tree occupies exactly 3 rows (header + 2 children) — the two
    // earlier frames were erased in place, not stacked.
    expect(screen.row(1)).toBe("● agents · 1/2 done");
    expect(screen.row(2)).toBe("├─ ✓ explore · 1.2s · 2 turns");
    expect(screen.row(3)).toBe("└─ ○ review");
    expect(screen.row(4)).toBe("");

    // Each label appears on exactly one row (no duplication from repaints).
    expect(screen.rowsContaining("explore")).toBe(1);
    expect(screen.rowsContaining("review")).toBe(1);
  });

  test("the tree renders below prior scrollback and keeps it intact", () => {
    const term = captureTerm();
    const live = new LiveRegion(term.out, true);
    const model = new AgentTreeModel();

    // Scrollback (the `agents: running …` header) written straight to the sink.
    term.out.write("agents: running explore (cap 1)\r\n");
    model.applyUnit("explore", "start");
    live.render(
      renderAgentTree(model.rows(), { columns: 60, frame: 0, color: false })
    );

    const screen = screenOf(term.bytes());

    expect(screen.row(1)).toBe("agents: running explore (cap 1)");
    expect(screen.row(2)).toBe("● agents · 1 running · 0/1 done");
    expect(screen.row(3)).toBe("└─ ⠋ explore");
  });

  test("clear() erases the region and frees the space for scrollback below", () => {
    const term = captureTerm();
    const live = new LiveRegion(term.out, true);
    const model = new AgentTreeModel();

    model.applyUnit("explore", "start");
    live.render(
      renderAgentTree(model.rows(), { columns: 60, frame: 0, color: false })
    );
    live.clear();

    // After clear, the result block prints where the tree was.
    term.out.write("=== explore: done ===\r\n");

    const screen = screenOf(term.bytes());

    expect(screen.rowsContaining("agents ·")).toBe(0); // tree gone
    expect(screen.text()).toContain("=== explore: done ===");
  });

  test("non-TTY sink is a no-op (piped runs never emit escape sequences)", () => {
    const chunks: string[] = [];
    const live = new LiveRegion(
      { write: (s) => (chunks.push(s), true), isTTY: false },
      true
    );

    live.render(["● agents · 0/1 done", "└─ ○ x"]);
    live.clear();

    expect(chunks).toHaveLength(0);
  });
});
