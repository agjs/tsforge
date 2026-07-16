#!/usr/bin/env bun
// Run the project typecheck on TypeScript 7's native compiler, resolved the SAME
// robust way the gate does (resolveTs7Tsc walks up for both the monorepo and
// published/hoisted layouts) — NOT a hardcoded node_modules path, which breaks
// when the package manager hoists @typescript/native somewhere else (e.g. CI).
import { spawnSync } from "node:child_process";
import { resolveTs7Tsc } from "../src/gate/tool-paths";

const bin = resolveTs7Tsc();
const res = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });

process.exit(res.status ?? 1);
