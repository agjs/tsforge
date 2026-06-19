import { test, expect } from "bun:test";
import { isLongRunningServerCommand } from "../src/loop/tools/file-ops";

test("flags never-exiting dev servers and watchers", () => {
  const servers = [
    "bun run dev",
    "bun dev",
    "npm run dev",
    "npm start",
    "pnpm dev",
    "yarn start",
    "npx vite",
    "bunx serve",
    "vite",
    "vite dev",
    "vite serve",
    "vite preview",
    "vitest",
    "next dev",
    "nuxt dev",
    "astro dev",
    "ng serve",
    "nodemon server.ts",
    "serve dist",
    "http-server .",
    "tsc --watch",
    "tsc -w -p tsconfig.json",
    "tail -f log.txt",
    "sudo npm run dev",
    "PORT=3000 bun run dev",
    "vite || echo fail",
    // delegated through a package runner — the binary's OWN flags must be checked,
    // not stripped (these previously bypassed the guard)
    "npx tsc --watch",
    "npx tsc -w -p tsconfig.json",
    "bunx tail -f log.txt",
    "bun x vite",
  ];

  for (const cmd of servers) {
    expect(isLongRunningServerCommand(cmd)).toBe(true);
  }
});

test("lets one-shot commands (incl. builds) through", () => {
  const oneShot = [
    "bun run build",
    "bun test",
    "npm run build",
    "vite build",
    "next build",
    "astro build",
    "ng build",
    "npx vite build",
    "npx tsc --noEmit", // delegated one-shot typecheck — not a watcher
    "tsc --noEmit",
    "tail -n 50 log.txt",
    "ls -la",
    "git status",
    "echo dev", // not a server invocation
    "node scripts/seed.ts",
  ];

  for (const cmd of oneShot) {
    expect(isLongRunningServerCommand(cmd)).toBe(false);
  }
});

test("an explicitly backgrounded server is allowed (it returns immediately)", () => {
  // Backgrounding makes the command return, so it can't stall the loop — the
  // bounded drain in process.ts handles the lingering pipe.
  expect(isLongRunningServerCommand("bun run dev &")).toBe(false);
  expect(isLongRunningServerCommand("vite &")).toBe(false);
});
