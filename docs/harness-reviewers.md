# harness-reviewers — independent external review gate

An independent panel of _other_ models/binaries reviews a change to the tsforge
harness and produces a **deterministic, blocking verdict the builder cannot fake**.
Reviewers must be independent of the active builder model — the tool refuses a
reviewer that is the same model as the builder. CI is the authority; a local
pre-push hook is convenience.

## Configure the panel

Add a `reviewPanel` block to `~/.tsforge/models.json` (sibling to `models` /
`capabilities`). Two reviewer kinds:

```jsonc
{
  "active": "deepseek-v4-flash",
  "models": {
    "deepseek-v4-flash": { "baseUrl": "…", "model": "…" },
    "openrouter-reviewer": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "…", // any capable chat model, NOT the builder's
      "apiKeyEnv": "OPENROUTER_API_KEY",
    },
  },
  "reviewPanel": {
    "minReviewers": 2, // floored at 2 in code; a lower value is ignored
    "reviewers": [
      { "kind": "model", "id": "or", "entry": "openrouter-reviewer" },
      {
        "kind": "binary",
        "id": "grok",
        "argv": ["grok", "--always-approve", "-p"],
        "input": "arg", // "arg" | "stdin" | "tempfile"
        "timeoutMs": 180000,
        "parse": "raw", // "raw" | "json-fence"
      },
    ],
  },
}
```

- **model reviewer** — references a `models` entry by `entry` (reuses its baseUrl /
  key / headers). Rejected if its normalized `(baseUrl host, model id)` — or its
  entry name — equals the active builder's (the independence invariant).
- **binary reviewer** — `argv` is spawned as an array (no shell). `input` controls
  how the review request is delivered: `arg` (appended as the last argv element),
  `stdin` (piped), or `tempfile` (written to a temp file whose path is appended as
  the last argv; auto-deleted after). `parse`: `raw` treats stdout as the JSON
  object; `json-fence` extracts the last ```json fenced block.
- The review request handed to every reviewer includes a skeptical, reject-by-default
  system contract plus the house-rules rubric, so binaries (e.g. grok) return the
  required JSON shape without extra prompting.

Configure **2+ reviewers, all independent of the builder.** A panel that can't reach
`minReviewers` successful reviews BLOCKS ("insufficient reviewers").

## Run

```bash
tsforge harness-review [--base <ref>] [--intent "what & why"] [--quick] [--ci] [--install-hook]
```

Flow: gather the change (`git diff <base>...HEAD`, default base = merge-base with
`main`) → run `bun run validate` FIRST (red → BLOCK immediately, panel not spent) →
enforce a diff budget (too large → BLOCK "split the PR") → require a non-generic
intent (`--intent` > commit subject; generic/empty → BLOCK) → invoke all reviewers
in parallel → deterministic `aggregate` → print verdict + write an audit artifact to
`.tsforge/harness-review/<cacheKey>.json` (cacheKey = hash of tree + panel-config +
rubric version, so any of those changing is a cache miss). **Exit: 0 = PASS, 1 = BLOCK.**

- `--quick` — one external reviewer + validate (fast local iteration).
- `--ci` — strict, no cache, no hook install (CI's mode; the enforcement of record).
- `--base <ref>` — override the diff base.
- `--intent "…"` — the change's purpose (required when the commit subject is generic).
- `--install-hook` — prints the command to activate the pre-push hook.

## Block rules (deterministic aggregator)

In order (first match blocks): fewer than `minReviewers` succeeded → any reviewer
`reject` → any single `critical` finding coded `security`/`supply-chain` → ≥2
reviewers raise a `critical|major` at the same locus `(file, findingCode)` →
a majority of reviewers request changes with at least one major finding. Otherwise
PASS. Errored/timed-out reviewers are never counted as approvals.

## Enforcement

- **CI (authority):** `.github/workflows/harness-review.yml` runs
  `tsforge harness-review --ci` on PRs touching `packages/core/**`, blocking merge.
- **Pre-push (convenience):** `.githooks/pre-push` runs the panel only when
  `packages/core/**` changed. Activate with `git config core.hooksPath .githooks`
  (off by default so it can't block pushes before a panel is configured). Bypassable
  with `--no-verify`; CI still enforces.

## Independence invariant (the point)

The builder reacts to findings and re-runs; it never emits a PASS. The verdict is the
panel's, computed by deterministic code, runnable identically by a human or CI. The
audit artifact records which builder model was active at review time, so independence
can be checked after the fact.
