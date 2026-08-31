import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded (see bunfig.toml [test].preload) before any test file runs.
//
// Without this, `models-config.ts`/`session.ts` resolve `~/.tsforge` from the
// REAL developer machine, so a Session-creating test picks up whatever MCP
// servers happen to be in the developer's actual `~/.tsforge/models.json` and
// tries to connect to them for real (observed: real network calls to
// mcp.linear.app/mcp.sentry.dev/mcp.notion.com via `npx mcp-remote`, several
// seconds each, blowing past bun's 5s default test timeout and failing
// unrelated tests). Point every test run at a fresh, empty, per-run directory
// instead, so the suite never depends on — or reaches out through — whatever
// happens to be configured on the machine running it.
process.env.TSFORGE_HOME = mkdtempSync(join(tmpdir(), "tsforge-test-home-"));
