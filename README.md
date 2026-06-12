<p align="center">
  <a href="https://github.com/agjs/tsforge">
    <strong>tsforge</strong>
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-e8e8ed?style=for-the-badge&labelColor=090909" alt="MIT">
  <img src="https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=fbf0df&labelColor=090909" alt="Bun">
  <img src="https://img.shields.io/badge/TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=3178c6&labelColor=090909" alt="TypeScript">
</p>

<p align="center">
  <strong>TypeScript coding harness with a deterministic gate.</strong><br />
  Stack-aware guardrails, stream-level correction, and a repair loop until your acceptance check passes.
</p>

<p align="center">
  <a href="https://tsforge.dev"><img src="https://img.shields.io/badge/tsforge.dev-2563eb?style=for-the-badge&labelColor=090909" alt="tsforge.dev"></a>
  <a href="https://github.com/agjs/tsforge/tree/main/packages/core"><img src="https://img.shields.io/badge/packages--core-2563eb?style=for-the-badge&labelColor=090909" alt="packages/core"></a>
  <a href="https://github.com/agjs/tsforge/tree/main/apps/docs"><img src="https://img.shields.io/badge/apps--docs-2563eb?style=for-the-badge&labelColor=090909" alt="apps/docs"></a>
</p>

Documentation lives at [tsforge.dev](https://tsforge.dev) — start with the [Quickstart](https://tsforge.dev/quickstart/).

## Why

tsforge started as an experiment: could a 27B model produce merge-ready TypeScript if the harness enforced `tsc`, stack rules, and stream corrections? It could. The same guardrails work with any OpenAI-compatible model. [Read the origin story on tsforge.dev](https://tsforge.dev/big-picture/).

## What it does

- **Deterministic gate** — typecheck, ESLint, format, tests; structured errors drive repair
- **13 rule packs** — stack-aware ESLint rules (Elysia, Drizzle, React, BullMQ, …)
- **10 meta-rules** — config, CI, supply-chain, and test-sibling checks outside AST
- **Hashline edits** — content-hash-anchored line edits with snapshot recovery
- **TTSR** — stream-interrupting rules that stop bad tool args mid-generation
- **Write diagnostics** — instant per-file type errors on every edit/create
- **Repair ladder** — cost-ordered tool-call repair before re-asking the model
- **A/B evals** — sweep feature variants and compare edit mechanisms

## Quickstart

```bash
curl -fsSL https://tsforge.dev/install.sh | bash

mkdir -p ~/.tsforge
cat > ~/.tsforge/models.json <<'EOF'
{
  "active": "qwen-local",
  "models": {
    "qwen-local": {
      "baseUrl": "http://localhost:8000/v1",
      "model": "qwen3.6-27b",
      "thinking": true
    }
  }
}
EOF

tsforge
```

Alternative: `bun install -g tsforge` once the package is on npm. See [Quickstart](https://tsforge.dev/quickstart/) for model config and flags.

Documentation lives at [tsforge.dev](https://tsforge.dev) — start with the [Welcome page](https://tsforge.dev/).

| Doc | Purpose |
| --- | --- |
| [tsforge.dev](https://tsforge.dev) | product docs (Quickstart, gate, guardrails, eval, reference) |
| [packages/core/RULES.md](packages/core/RULES.md) | generated rule catalog (also synced to [tsforge.dev/reference/rules-catalog/](https://tsforge.dev/reference/rules-catalog/)) |

## License

MIT — see [LICENSE](LICENSE).
