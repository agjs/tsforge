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
  <strong>Flagship-quality TypeScript from a local model.</strong><br />
  An opinionated coding harness for Qwen-class local models — deterministic gate, stack-aware guardrails, stream-level correction.
</p>

<p align="center">
  <a href="https://tsforge.dev"><img src="https://img.shields.io/badge/tsforge.dev-4ade80?style=for-the-badge&labelColor=090909" alt="tsforge.dev"></a>
  <a href="https://github.com/agjs/tsforge/tree/main/packages/core"><img src="https://img.shields.io/badge/packages--core-4ade80?style=for-the-badge&labelColor=090909" alt="packages/core"></a>
  <a href="https://github.com/agjs/tsforge/tree/main/apps/docs"><img src="https://img.shields.io/badge/apps--docs-4ade80?style=for-the-badge&labelColor=090909" alt="apps/docs"></a>
</p>

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
git clone https://github.com/agjs/tsforge.git && cd tsforge
bun install
mkdir -p ~/.tsforge
# point at your local OpenAI-compatible server
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
bun packages/core/src/cli.ts
```

Documentation lives at [tsforge.dev](https://tsforge.dev) — start with the [Welcome page](https://tsforge.dev/).

| Doc | Purpose |
| --- | --- |
| [apps/docs](apps/docs/) | living harness docs (Astro Starlight) |
| [packages/core/RULES.md](packages/core/RULES.md) | full rule catalog (generated) |
| [EVAL_GUIDE.md](EVAL_GUIDE.md) | A/B sweep workflow |
| [ROADMAP.md](ROADMAP.md) | what ships next |

## License

MIT — see [LICENSE](LICENSE).
