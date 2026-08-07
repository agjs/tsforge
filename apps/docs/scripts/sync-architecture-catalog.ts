#!/usr/bin/env bun
/**
 * Copy packages/core/ARCHITECTURE.md into Starlight content with frontmatter.
 * Run before `astro build` / `astro dev` so the subsystem map lives on tsforge.dev.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(docsRoot, "../..");
const source = join(repoRoot, "packages/core/ARCHITECTURE.md");
const target = join(docsRoot, "src/content/docs/internals/subsystems.md");

const body = readFileSync(source, "utf-8").replace(/^# Architecture map\n\n/, "");

const frontmatter = `---
title: Subsystems
description: Every subsystem in packages/core, how they depend on each other, and where the entry points and adapter seams live — generated from source.
---

`;

writeFileSync(target, frontmatter + body, "utf-8");
console.log("sync-architecture-catalog: wrote internals/subsystems.md");
