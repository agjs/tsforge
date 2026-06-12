#!/usr/bin/env bun
/**
 * Copy packages/core/RULES.md into Starlight content with frontmatter.
 * Run before `astro build` / `astro dev` so the rule catalog lives on tsforge.dev.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(docsRoot, "../..");
const source = join(repoRoot, "packages/core/RULES.md");
const target = join(docsRoot, "src/content/docs/reference/rules-catalog.md");

const body = readFileSync(source, "utf-8").replace(
  /^# Rules and Meta-Rules Catalog\n\n/,
  "",
);

const frontmatter = `---
title: Rule catalog
description: Every ESLint pack rule and meta-rule enforced by the gate — generated from rule pack sources.
---

`;

writeFileSync(target, frontmatter + body, "utf-8");
console.log("sync-rules-catalog: wrote reference/rules-catalog.md");
