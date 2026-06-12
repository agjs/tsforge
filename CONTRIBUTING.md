# Contributing

Most code here is written by AI agents under a deterministic gate. The conventions exist so `bun run validate` is a reliable signal.

## Dev setup

- **Bun** ≥ 1.3.14 (`packageManager` in root `package.json`)
- **Model registry** at `~/.tsforge/models.json` — see [models-config.ts](packages/core/src/models-config.ts) for shape
- **Local model** — OpenAI-compatible server at `http://localhost:8000/v1` by default

```bash
bun install
bun run validate   # must pass before merge
```

## Merge bar

`bun run validate` runs four steps in order:

1. `bun run typecheck` — strict TypeScript
2. `bun run lint` — ESLint on `packages/`
3. `bun run format:check` — Prettier
4. `bun test packages` — 680+ tests

All four must pass. Do not disable ESLint rules inline, do not use `any`, and do not use `as` or `!` to bypass failures.

## House rules agents get wrong

### Type assertions

```ts
// wrong
const id = (row as { id: string }).id;

// right
function isRow(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string";
}
if (!isRow(row)) throw new Error("unexpected row shape");
const id = row.id;
```

### Meta-shape tests vs behavioral fixtures

```ts
// wrong — asserts export shape, not behavior
expect(typeof rule.create).toBe("function");

// right — exercise the rule against real source
const result = rule.create(context).Program({
  node: parseSource("process.env.FOO"),
});
expect(result).toHaveLength(1);
expect(result[0].messageId).toBe("noDirectProcessEnv");
```

## Add a rule pack

1. Create `packages/core/src/rule-packs/<pack-id>/` with `index.ts`, `rules/`, and rule files
2. Export an `IRulePack` from the pack index
3. Register in `RULE_PACKS` ([rule-packs/index.ts](packages/core/src/rule-packs/index.ts))
4. Add a descriptor in `PACK_REGISTRY` ([stack-detection/packs.ts](packages/core/src/stack-detection/packs.ts))
5. Add behavioral tests under `packages/core/tests/` and regenerate docs:

```bash
bun run rules:docs
bun run rules:build
```

## Add a meta-rule

1. Create a rule file under `packages/core/src/meta-rules/rules/<category>/`
2. Register in [meta-rules/registry.ts](packages/core/src/meta-rules/registry.ts)
3. Add a behavioral test in `packages/core/tests/meta-rules.test.ts`
4. Regenerate rule docs (same commands as above)

## Skipped tests

Browser oracle tests in `packages/core/tests/browser-oracle.test.ts` skip unless:

- `TSFORGE_BROWSER_TESTS=1`, and
- Playwright chromium is installed and launchable

Run them locally with:

```bash
TSFORGE_BROWSER_TESTS=1 bun test packages/core/tests/browser-oracle.test.ts
```
