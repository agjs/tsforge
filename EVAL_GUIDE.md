# A/B Evaluation Guide for Local-Model Features

This guide walks through running A/B sweeps to measure the impact of new local-model features (TTSR, hashline, LSP write feedback) on benchmark suite performance.

## Feature Flags

The following environment variables toggle local-model features:

- `TSFORGE_TTSR` — stream-interrupting rules (default: enabled; set to `0` to disable)
- `TSFORGE_HASHLINE` — hashline edit tool + stale-anchor recovery (default: enabled; set to `0` to disable)
- `TSFORGE_LSP_WRITE_FEEDBACK` — instant per-file diagnostics on write (default: enabled; set to `0` to disable)

## Running a Feature Sweep

To compare feature variants across a benchmark, use the extended `sweep.ts` script. It accepts a `TSFORGE_FEATURE_VARIANTS` env var that lists dimensions to sweep (cartesian product).

### Example: Compare hashline on/off

```bash
# Sweep baseline (hashline on) vs hashline off
TSFORGE_SEED=money \
TSFORGE_TEMPS=0 \
TSFORGE_REPEATS=2 \
TSFORGE_FEATURE_VARIANTS=hashline \
bun run packages/core/scripts/sweep.ts
```

This creates 4 runs: `money-hashline=on-t0-...` and `money-hashline=off-t0-...` (2 each).

### Example: Multi-dimensional sweep

```bash
# Sweep TTSR × hashline (2 features = 4 variants)
TSFORGE_SEED=saas-crm \
TSFORGE_TEMPS=0.5 \
TSFORGE_REPEATS=3 \
TSFORGE_FEATURE_VARIANTS=ttsr,hashline \
bun run packages/core/scripts/sweep.ts
```

This runs `3 repeats × 2 temps × 4 variants = 24 runs total`, generating run IDs like:
- `saas-crm-ttsr=on,hashline=on-t0.5-...`
- `saas-crm-ttsr=on,hashline=off-t0.5-...`
- `saas-crm-ttsr=off,hashline=on-t0.5-...`
- `saas-crm-ttsr=off,hashline=off-t0.5-...`

Each run dir contains `run.log` (full transcript) and `result.json` (structured metrics + feature flags).

## Analyzing Edit Mechanisms

After a sweep completes, use `edit-benchmark.ts` to compare edit tool performance across hashline on/off.

### Example: Compare edits vs edit_lines

```bash
bun run packages/core/scripts/edit-benchmark.ts \
  evals/money-hashline=on-t0-* \
  evals/money-hashline=off-t0-*
```

Output: ASCII table comparing the variants on:
- `edit` tool calls and success rate (rejections per variant)
- `edit_lines` tool calls and success rate
- Stale-anchor recovery attempts (hashline feature)
- Mean tool-args bytes (token-cost proxy)
- Gate failure counts
- Turns to green
- Pass rate
- Average quality score

### JSON output

```bash
bun run packages/core/scripts/edit-benchmark.ts \
  --json evals/comparison.json \
  evals/money-hashline=on-t0-* \
  evals/money-hashline=off-t0-*
```

Writes structured comparison data to `evals/comparison.json` for downstream analysis.

## Run Artifacts

Each run dir contains:

- `run.log` — live event transcript (rendered for human reading)
- `result.json` — structured run metrics:
  ```json
  {
    "seed": "money",
    "runId": "money-hashline=on-t0-20260612-120000-1",
    "temperature": 0,
    "features": { "TSFORGE_HASHLINE": "1" },
    "status": "done|blocked",
    "cycles": 5,
    "ms": 42000,
    "quality": 4,
    "judgeNotes": "...",
    "tasks": [ { "cycles": 5, "edits": 3, "regressions": 0, ... } ]
  }
  ```

## Events Used for Analysis

The edit-benchmark tool parses run.log to extract:

- `✎ edit` — standard edit tool calls
- `edit_lines` — hashline edit tool calls
- `edit_lines ... REJECTED` — stale-anchor or parse failures
- `edit ... REJECTED` — out-of-scope or size rejections
- `snapshot merge` — stale-anchor recovery attempts (3-way merge)
- `turn N: red (K errors)` — gate failures
- `· turn N: GREEN` — green result achieved
- `turn N: asking model` — turn count tracking

## Interpretation

### Edit success rates

If `hashline=on` has a higher `edit_lines % success` than `hashline=off`'s `edit % success`, the hashline feature is reducing edit rejections (better anchor recovery).

### Stale-anchor recoveries

Non-zero `stale recovery` values on hashline-on runs show the 3-way merge is being used. If correlated with a similar or better pass rate, recovery is working.

### Turns to green

Lower `turns to green` on feature-on variants suggests the feature reduces loop iterations (better guidance).

### Token efficiency

`mean args (bytes)` is a proxy for tool-args size. Smaller args with similar edit success rate = better token efficiency.

### Pass rate + quality trade-off

Verify that enabling a feature doesn't reduce overall pass rate or quality (by more than noise).

## Workflow: Landing a New Feature

1. **Create the feature** (e.g., TSFORGE_HASHLINE) with a sensible default (on or off).
2. **Run a small baseline sweep** (e.g., 2 repeats, temp=0):
   ```bash
   TSFORGE_SEED=money TSFORGE_TEMPS=0 TSFORGE_REPEATS=2 \
   bun run packages/core/scripts/sweep.ts
   ```
3. **Disable the feature** and re-run the same seed/temp/repeats:
   ```bash
   TSFORGE_SEED=money TSFORGE_TEMPS=0 TSFORGE_REPEATS=2 \
   TSFORGE_<FEATURE>=0 bun run packages/core/scripts/sweep.ts
   ```
4. **Compare**: Use `analyze-runs.ts` or `edit-benchmark.ts` on both sweeps.
5. **Document findings** in the PR (e.g., "hashline enabled: 85% pass vs 72% baseline, −25% mean args bytes").
6. **Land**: Set the feature's default and merge.

## Debugging Event Capture

If metrics seem incomplete, check that events are reaching the log:

- `grep "edit" run.log` — find edit tool calls
- `grep "REJECTED" run.log` — find rejections (should correlate with gate reds)
- `grep "tool_input_rejected" run.log` — find malformed args (parsed by analyze-malformed.ts)
- `grep "repair:" run.log` — find tool-args repairs (L0–L3)
- `grep "ttsr" run.log` — find TTSR interrupts (when enabled)

All events are persisted to run.log via the `renderEvent()` pipeline, so the log is the source of truth.
