# Deploy: tsforge.dev on Cloudflare Pages

The site in `apps/docs/` is an [Astro Starlight](https://starlight.astro.build) docs site. It builds to static files, deploys to [Cloudflare Pages](https://pages.cloudflare.com), and is served at https://tsforge.dev.

## One-time setup

1. **Cloudflare account** with DNS for `tsforge.dev`.

2. **Create a Pages project.**
   - Cloudflare dashboard → Workers & Pages → Create application → Pages → Connect to Git.
   - Authorize GitHub and select the `agjs/tsforge` repository.
   - Project name: `tsforge-docs` (becomes the `*.pages.dev` subdomain).

3. **Build settings.**

   | Setting                | Value              |
   | ---------------------- | ------------------ |
   | Production branch      | `main`             |
   | Framework preset       | Astro              |
   | Build command          | `bun run build:ci` |
   | Build output directory | `dist`             |
   | Root directory         | `apps/docs`        |
   | Bun / Node             | 1.3.14 / 24        |
   | Environment variables  | _(none)_           |

4. **Custom domain.**
   - Pages project → Custom domains → Set up a custom domain → `tsforge.dev`.
   - Cloudflare provisions the cert automatically when the zone is on Cloudflare.

## Build locally

```bash
cd apps/docs
bun install   # from repo root: bun install at monorepo root
bun run dev   # local preview
bun run build:ci   # same command Cloudflare Pages and CI use
bun run preview
```

The rule catalog page is generated at build time from `packages/core/RULES.md` via `sync:rules`.

## How deploys work

- Push to `main` (docs paths) → Cloudflare auto-builds with `bun run build:ci`.
- Pushes to other branches → preview deployment at `<branch>.tsforge-docs.pages.dev`.
- Manual production deploy: `bun run deploy` (runs `build:ci` then `wrangler deploy`).
- Rollback: Pages dashboard → Deployments → pick a previous deployment → Rollback.

## Notes

- **No CNAME file.** Cloudflare Pages binds the custom domain via the dashboard, not via a `public/CNAME` file.
- **install.sh** is served from `apps/docs/public/install.sh` and must stay in sync with `scripts/install.sh` at the repo root (core CI checks this).
