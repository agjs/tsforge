# Benchmark seeds

Each subdirectory here is a **seed**: a small, self-contained task the harness can
run end-to-end to measure how a model does. A seed is the unit you point a sweep at
when comparing models or A/B-testing a feature.

These ship in the repo (committed), so `bun run eval:sweep` works on a fresh clone.
Run outputs are written to the gitignored `evals/` directory, never here.

## What's in a seed

| File | Role |
| --- | --- |
| `<seed>.spec.md` | the task: frontmatter (`id`, `title`, `verify`, `mode`) + acceptance criteria + tasks (each with an `accept:` command, editable `files:`, read-only `context:`). |
| test files | the gate — referenced as `context:` so the model reads them but cannot edit them. |
| solution files | a reference implementation. In `scratch` mode the harness deletes the editable `files:` to start from red, then the model rebuilds them until the tests pass. |

See [docs: Spec format](../apps/docs/src/content/docs/spec/format.mdx) for the full field reference.

## The seeds

| Seed | Shape | What it stresses |
| --- | --- | --- |
| `money` | single file, pure logic | currency-safe integer-cent arithmetic, parsing/formatting, and a no-lost-cents allocation algorithm — easy to state, hard to get exactly right. |
| `orders` | three modules + a fixed type contract | a cross-module pricing engine: a discriminated discount union (percent / fixed / bogo), region tax, and rolling lines up into an order summary. |

Both are pure TypeScript gated by `bun test`, so they run anywhere with no extra
setup or network access.

## Running one

```bash
TSFORGE_SEED=money TSFORGE_TEMPS=0 TSFORGE_REPEATS=2 bun run eval:sweep
```

Point the model and (optional) judge at any endpoint with `TSFORGE_BASE_URL` /
`TSFORGE_MODEL` (and `TSFORGE_JUDGE_URL` / `TSFORGE_JUDGE_MODEL`) to compare models
on the same seed. See [docs: A/B testing](../apps/docs/src/content/docs/eval/ab-testing.mdx).

## Adding a seed

1. Create `seeds/<name>/` with a `<name>.spec.md`, the test(s), and a working
   reference solution.
2. Make sure the solution passes — `cd seeds/<name> && bun test`.
3. Keep it pure and dependency-free where you can, so it runs anywhere.
