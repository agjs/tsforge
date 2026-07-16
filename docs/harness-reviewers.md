# harness-reviewers — independent external review gate

An independent panel of _other_ models/binaries reviews a change to the tsforge
harness and produces a **deterministic, blocking verdict the builder cannot fake**.
Reviewers must be independent of the active builder model — the tool refuses a
reviewer that is the same model as the builder. The panel runs **locally** (the
pre-push hook + `tsforge harness-review`), because it uses local binaries (grok,
codex) and local/keyed model endpoints that a CI runner cannot reach. The local
pre-push hook is the authority; `core-ci.yml` still enforces the code gate
(typecheck/lint/format/test) server-side, independently of the panel.

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
- Reviewers judge the change **against the codebase, not just the diff**: the prompt
  carries the changed files' full current contents (bounded by the diff budget, with
  any overflow reported — never silently dropped), and the agentic binary reviewers
  (grok, codex) run in the repo and can read further on their own. Binary reviewers
  are invoked in their natural review mode (no artificial turn cap); a per-reviewer
  `timeoutMs` is the only backstop.

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
- `--ci` — strict, no cache. Runs the panel non-interactively; usable from any
  automation that can reach the reviewers (for this repo that means a local
  runner, since the panel uses local binaries).
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

The panel uses local binaries (grok, codex) and local/keyed model endpoints, so it
is **not** a CI gate — a GitHub runner cannot reach those. Enforcement is local:

- **Pre-push (authority):** `.githooks/pre-push` runs the panel when
  `packages/core/**` changed. Activate with `git config core.hooksPath .githooks`
  (off by default so it can't block pushes before a panel is configured). Bypassable
  with `--no-verify`.
- **Code gate (CI, independent):** `core-ci.yml` still runs
  typecheck/lint/format/test server-side on every PR — that half of the gate does
  not depend on the panel.
- **CI panel variant (optional):** a CI job could run the _model_ reviewers only
  (via `apiKeyEnv` + GitHub secrets), skipping the local binaries. Not enabled here;
  it needs repo secrets set by the maintainer.

## Diagnose a parked/failed build (`tsforge harness-diagnose`)

The same panel can read a build's transcript and tell you WHY it parked, instead
of only judging a code diff:

```bash
tsforge harness-diagnose <build-log.jsonl> [--domain X] [--reason "…"] [--max-chars N] [--tail N]
```

Flow: read the transcript (both log shapes — the flat reporter jsonl and the
typed `LedgerWriter` `{type,payload}` ledger) → `sliceBuildLog` extracts a
signal-first, budgeted slice: each event is flattened to one capped line,
identical lines are deduped as `(×N)`, failing commands keep their
`output`/`errors` diagnostics while green output is elided for cost, and whatever
is dropped is **counted and reported** — never silent (~130K→24K tokens on a real
run) → each reviewer gets a
skeptical diagnosis contract asking for ONE JSON object
`{ category, confidence, rootCause, suggestedFix }` where `category` is one of a
fixed enum (`gate-parity`, `near-green-oscillation`, `scaffold-infra`,
`wrong-idiom`, `scope-freeze`, `prompt-contradiction`, `other`) → deterministic
`aggregateDiagnoses` picks the most-voted category (ties → the earlier/more
structural one) and surfaces the agreeing reviewers' fixes. Errored reviewers are
counted, never voted. Output + an artifact under `.tsforge/harness-diagnose/`.
Advisory (always exit 0) — it informs a fix, it is not a gate.

## Independence invariant (the point)

The builder reacts to findings and re-runs; it never emits a PASS. The verdict is the
panel's, computed by deterministic code, runnable identically by a human or by
automation. The audit artifact records which builder model was active at review
time, so independence
can be checked after the fact.
