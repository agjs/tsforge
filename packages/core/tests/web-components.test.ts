import { test, expect } from "bun:test";
import { materializeComponents, THEMES } from "../src/web-components";

test("materialize writes the theme token block + one file per component", () => {
  const out = materializeComponents("minimal", ["card", "button"]);

  expect(Object.keys(out).sort()).toEqual([
    "src/components/ui/button.tsx",
    "src/components/ui/card.tsx",
    "src/index.css",
  ]);
  // index.css carries the theme's token block.
  expect(out["src/index.css"]).toContain('@import "tailwindcss"');
  expect(out["src/index.css"]).toContain("--radius: 0.5rem");
});

test("structure is invariant; only the per-vibe delta classes change", () => {
  const min = materializeComponents("minimal", ["card"])[
    "src/components/ui/card.tsx"
  ];
  const fut = materializeComponents("futuristic", ["card"])[
    "src/components/ui/card.tsx"
  ];

  // Same structure in both (the tested invariant part).
  for (const card of [min, fut]) {
    expect(card).toContain("export function Card");
    expect(card).toContain("bg-card text-card-foreground");
    expect(card).toContain("cn(");
  }

  // Only the futuristic vibe injects its delta.
  expect(fut).toContain("backdrop-blur-sm");
  expect(min).not.toContain("backdrop-blur-sm");
});

test("an empty delta collapses cleanly — no leftover `$DELTA`, no double space", () => {
  const min = materializeComponents("minimal", ["button", "input", "label"]);

  for (const content of Object.values(min)) {
    expect(content).not.toContain("$DELTA");
    // an empty delta must not leave a double space before the closing quote
    expect(content).not.toContain('50 "');
  }
});

test("composition blocks materialize and compose the primitives", () => {
  const out = materializeComponents("minimal", [
    "app-shell",
    "field",
    "page-header",
  ]);

  // app-shell is the sidebar+nav layout (renders <Outlet/>, router-backed)
  const shell = out["src/components/ui/app-shell.tsx"];

  expect(shell).toContain("export function AppShell");
  expect(shell).toContain("@tanstack/react-router");
  expect(shell).toContain("<Outlet");

  // field composes the Label primitive + shows an error slot
  const field = out["src/components/ui/field.tsx"];

  expect(field).toContain("export function Field");
  expect(field).toContain('from "@/components/ui/label"');
  expect(field).toContain("text-destructive");
});

test("the token preset is the vibe lever — themes ship different palettes/radius", () => {
  expect(THEMES.minimal.tokens).toContain("--radius: 0.5rem");
  expect(THEMES.futuristic.tokens).toContain("--radius: 0rem");
  expect(THEMES.minimal.tokens).not.toBe(THEMES.futuristic.tokens);
});
