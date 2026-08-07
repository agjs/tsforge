#!/usr/bin/env bun
// Generate ARCHITECTURE.md — the subsystem map — from packages/core/src.
// Orchestration only: everything decidable lives in src/architecture, where tests reach it.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArchitecture, renderArchitectureMd } from "../src/architecture";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(packageRoot, "src");
const target = join(packageRoot, "ARCHITECTURE.md");

const architecture = await buildArchitecture(srcRoot);

await Bun.write(target, renderArchitectureMd(architecture));

console.log(
  `build-architecture-md: ${architecture.subsystems.length} subsystems, ` +
    `${architecture.edges.length} edges, ${architecture.cycles.length} mutual pairs`
);
