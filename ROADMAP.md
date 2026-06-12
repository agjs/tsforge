# tsforge — Roadmap

## Context

Local-model coding harness for TypeScript web projects:

- `packages/core/` — implement loop, gate, rule packs, meta-rules, hashline, TTSR, eval scripts
- `apps/docs/` — Astro Starlight docs (tsforge.dev)

Shipped in v0.1.0:

- Stack detection + 13 ESLint rule packs (~50 rules)
- Meta-rule engine (10 rules: config, CI, supply chain, testing)
- `tsforge.config.json` overrides (force stack, exclude packs, severity tuning)
- Tool-call repair ladder (L0–L3)
- Hashline edit tool with snapshot recovery
- TTSR stream-interrupting rules
- Instant write diagnostics (LSP feedback on edit/create)
- A/B eval support ([EVAL_GUIDE.md](EVAL_GUIDE.md))

**Sequencing rule:** Measured wins first. No feature defaults change and no 1.0 tag until the A/B numbers against the reference local model exist.

---

## Road to 1.0

- Run sweeps: `TSFORGE_FEATURE_VARIANTS=ttsr,hashline` across benchmark seeds
- Publish numbers in README (pass rate, edit success, tokens saved)
- Tune defaults from data (TTSR rules, hashline on/off, write feedback)
- Freeze config and tool surface

---

## Candidate work

- Rule packs: Next.js, Hono, Prisma
- TTSR rules derived from eval failure patterns
- Meta-rule severity learning from repair-loop telemetry
- Wire `.tsforge/rules.json` custom TTSR rules into the loop

---

## Completed

| Commit | Phase |
| --- | --- |
| `2198361` | stack-detection module for rule pack selection |
| `9c0964e`–`2936a6f` | vendored stack-agnostic ESLint rule packs + behavioral fixtures |
| `8b7e9f3`–`c42b00f` | Drizzle + BullMQ packs |
| `9da5e82`–`ab64600` | Elysia, structured-logging, frontend, auth packs |
| `8c19dfd` | wire stack-aware packs into gate and prompt |
| `1d67899`–`3591e1b` | meta-rule engine + gate integration + unified rule docs |
| `6b88b54` | tsforge.config.json escape hatch |
| `a803d1a` | cost-ordered tool-call repair ladder |
| `f6a21db` | hashline edit tool with snapshot recovery |
| `9871ace`–`37f8795` | TTSR stream-interrupting rules |
| `a2126f0` | instant per-file type diagnostics on write |
| `4b33bb4` | A/B eval support for TTSR, hashline, write-feedback |
