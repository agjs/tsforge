/**
 * Opinionated, MODERN web scaffolds — the file sets tsforge lays down so the
 * model fills a known-good, building project instead of improvising. Every stack
 * is Vite-based (real bundler oracle), strict-TS, and proven green end-to-end
 * (vite build + tsc strict + eslint + headless browser render) before shipping.
 *
 *   react   — the FULL kit: Vite + React 19 + Tailwind v4 + shadcn/ui (cn, base
 *             components, theme tokens) + TanStack Router (file-based, route-tree
 *             codegen) + TanStack Query. The opinionated default.
 *   vanilla — Vite + TypeScript + Tailwind, no UI framework. The neutral choice.
 *
 * shadcn components + the generated routeTree.gen.ts are GENERATED, not the model's
 * output — so each stack lists `eslintIgnore` globs that exempt them from the
 * bundled strict eslint (they're still type-checked by tsc + vite build, and the
 * model may freely edit them — the eslintIgnore is only about not LINTING codegen).
 */
export type WebFramework = "react" | "vanilla";

export interface IWebTemplate {
  /** Short label for the banner. */
  label: string;
  /** Relative path → file content, written non-destructively at scaffold time. */
  files: Record<string, string>;
  /** eslint --ignore-pattern globs for vendored/generated code the model didn't write. */
  eslintIgnore: string[];
  /** System-prompt guidance describing the structure + conventions for this stack. */
  guidance: string;
}

const VITE_ENV_DTS = `/// <reference types="vite/client" />
`;

// Keep prettier (and so the gate's prettier --check) off vendored/generated code —
// same scope as eslintIgnore. The model's own files are the only ones formatted.
const PRETTIER_IGNORE = `node_modules
dist
src/components/ui
*.gen.ts
`;

// ─── react: the full kit ─────────────────────────────────────────────────────

const REACT_PACKAGE_JSON = `{
  "name": "app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "bun test"
  },
  "dependencies": {
    "@dnd-kit/core": "^6.3.1",
    "@dnd-kit/sortable": "^10.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "@radix-ui/react-slot": "^1.1.1",
    "@tanstack/react-query": "^5.62.0",
    "@tanstack/react-router": "^1.95.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.469.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "recharts": "^2.15.0",
    "tailwind-merge": "^3.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@tanstack/router-plugin": "^1.95.0",
    "@types/bun": "^1.3.14",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "^4.0.0",
    "tw-animate-css": "^1.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vite-tsconfig-paths": "^5.1.0"
  }
}
`;

const REACT_VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    // ignoreConfigErrors: an eval build runs nested under the harness repo, so
    // vite-tsconfig-paths walks UP the tree and can hit a foreign/broken tsconfig
    // (e.g. a stray test123/tsconfig.json) — without this it spews a parse error
    // into the gate output that the model misreads as its own. The app's own
    // tsconfig still resolves normally.
    tsconfigPaths({ ignoreConfigErrors: true }),
  ],
});
`;

const REACT_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": [],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules", "dist", "build", "**/*.test.ts", "**/*.test.tsx"]
}
`;

const REACT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>app</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const COMPONENTS_JSON = `{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
`;

const CN_UTILS = `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
`;

const REACT_INDEX_CSS = `@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
}

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}
`;

const BUTTON_TSX = `import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
`;

const ROOT_ROUTE_TSX = `import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => <Outlet />,
});
`;

// The placeholder home carries `data-tsforge-stub` (the SAME sentinel scaffold_routes
// stubs use) so the gate's stub-check FAILS until the model replaces it with the real
// home. Without this, an unbuilt app — just the scaffold + maybe some types — passes
// the gate (vite builds, this page renders non-blank, no scaffold_routes stubs to
// catch) and is falsely declared "done". The model removes the marker when it builds
// the real home.
const INDEX_ROUTE_TSX = `import { createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main data-tsforge-stub className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background text-foreground">
      <h1 className="text-3xl font-bold">app</h1>
      <Button>Get started</Button>
    </main>
  );
}
`;

const REACT_MAIN_TSX = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { routeTree } from "./routeTree.gen";
import "./index.css";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient();

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("missing #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
`;

// A STUB of TanStack Router's generated route tree, registering only the stock "/"
// route — shipped so the scaffold TYPECHECKS from turn 1. Without it, the tsc-only
// stages (the design-phase type-gate and the incremental check, which do NOT run a
// Vite build) can't resolve \`./routeTree.gen\`, so the stock main.tsx/index.tsx
// throw two unfixable errors ("Cannot find module './routeTree.gen'" + "createFileRoute
// ('/') not assignable to 'undefined'") that pin every interim check at a 2-error
// floor — the model never sees 0 errors, never settles, and burns its whole turn
// budget chasing them (observed on large multi-route apps stuck on exactly this).
// The Vite build overwrites this with the real tree (all routes) on every gate run.
// @ts-nocheck + eslint-disabled (matches what the generator emits; *.gen.ts is ignored).
const ROUTE_TREE_GEN = `/* eslint-disable */

// @ts-nocheck

// This file was automatically generated by TanStack Router.
// You should NOT make any changes in this file as it will be overwritten.

import { Route as rootRouteImport } from './routes/__root'
import { Route as IndexRouteImport } from './routes/index'

const IndexRoute = IndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => rootRouteImport,
} as any)

export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
}
export interface FileRoutesByTo {
  '/': typeof IndexRoute
}
export interface FileRoutesById {
  __root__: typeof rootRouteImport
  '/': typeof IndexRoute
}
export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath
  fullPaths: '/'
  fileRoutesByTo: FileRoutesByTo
  to: '/'
  id: '__root__' | '/'
  fileRoutesById: FileRoutesById
}
export interface RootRouteChildren {
  IndexRoute: typeof IndexRoute
}

declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/': {
      id: '/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof IndexRouteImport
      parentRoute: typeof rootRouteImport
    }
  }
}

const rootRouteChildren: RootRouteChildren = {
  IndexRoute: IndexRoute,
}
export const routeTree = rootRouteImport
  ._addFileChildren(rootRouteChildren)
  ._addFileTypes<FileRouteTypes>()
`;

const REACT_GUIDANCE = [
  "This is a Vite + React 19 + TypeScript + Tailwind v4 app with shadcn/ui and",
  "TanStack (Router + Query) — ALREADY scaffolded and its dependencies INSTALLED.",
  "Build the app by adding/editing files under src/. Do NOT touch vite.config.ts,",
  "index.html, tsconfig.json, components.json, or the build setup.",
  "FILE LAYOUT — VIEWS. ONE thing per file, and the GATE ENFORCES IT (lint errors,",
  "not style): a component .tsx holds ONLY imports + the component — NO inline types,",
  "constants, or helper functions. Every screen/feature is a VIEW:",
  "  • src/views/<Feature>/ — one folder per feature (PascalCase, e.g. Dashboard). Put:",
  "      – index.tsx — THE VIEW: the composition root. It imports its pieces from",
  "        ./components and the shared primitives in @/components/ui and assembles the",
  "        screen. This is the only component allowed at the feature root.",
  "      – components/<X>.tsx — the feature's own components, ONE component per file",
  "        (PascalCase). Create one ONLY when a piece needs local state, is reused in",
  "        the view, or is big enough to stand alone — otherwise compose primitives",
  "        directly in index.tsx. Do NOT wrap a single primitive in a feature name",
  "        (NO `DealsTable` around <Table> — render <Table> with deal columns instead).",
  "      – <feature>.types.ts — the feature's interfaces/types (I-prefixed).",
  "      – <feature>.constants.ts — its `as const` registries/label maps/column specs.",
  "      – <feature>.hooks.ts — custom hooks (data fetching, derived/computed state).",
  "        Hooks live HERE, never in a component body (no-state-in-component-body).",
  "  • A component .tsx (index.tsx or components/<X>.tsx) = imports + the component,",
  "    nothing else. A constant (label map, column spec) → <feature>.constants.ts. A type",
  "    → <feature>.types.ts (shared across features → src/shared/shared.types.ts). A pure",
  "    helper (formatCurrency, timeAgo) → src/lib/<name>.ts. Putting any of these atop a",
  "    component is a GATE ERROR (component-file-purity / component-folder-structure).",
  "  • Shared, reusable UI primitives live in @/components/ui (scaffold_ui) — they are",
  "    feature-agnostic. Anything feature-specific is a view component, never a primitive.",
  "  • NO CEREMONIAL VALIDATION for data you DEFINE in-app — a seed/constant you wrote",
  "    with a type already has its shape proven by the compiler, so NEVER create a",
  "    `*.validators.ts` or a `parse<X>`/`validate<X>`/`is<X>` over your own typed data:",
  "    that is dead ceremony and is REJECTED. Type it at the source and use it directly;",
  "    for a literal use `x satisfies IType`; narrow a discriminated union with a plain",
  "    `switch (x.kind)`. (The ONE place validation IS warranted: a real `fetch` response",
  "    — it crosses `unknown`, so narrow it with a guard there, never `as`-cast it.)",
  "  • ROUTES ARE THE APP — every PAGE the user asked for must be a real route, and a",
  "    component never mounted in a route is DEAD CODE. CREATE THEM ALL AT ONCE with the",
  "    `scaffold_routes` tool: call it ONCE (right after your types + services) listing",
  "    EVERY page — list pages, detail pages ($param, e.g. /accounts/$accountId), and",
  "    create/edit pages (e.g. /deals/create). It writes every src/routes/*.tsx stub AND",
  "    the real home at src/routes/index.tsx and regenerates the route tree, so the whole",
  "    app navigates and every <Link to>/navigate target type-checks from that point on.",
  "    NEVER hand-write or hand-edit route files or createFileRoute paths. A route file is",
  "    a THIN SHELL: it renders its view (e.g. `import { Dashboard } from",
  "    '@/views/Dashboard'`), no UI logic of its own. Build the views ONE feature at a time.",
  "      – shadcn/ui primitives stay in @/components/ui (Button exists; add more there",
  "        following cva + cn() + tokens).",
  "  • src/routeTree.gen.ts is AUTO-GENERATED by the Vite build from your route",
  "    files — NEVER create or edit it, and never try to fix it. If you see",
  "    `Cannot find module './routeTree.gen'` or `createFileRoute('/...')` →",
  "    `not assignable to parameter of type 'undefined'`, that is NOT a routeTree",
  "    problem: it means one of your src/routes/*.tsx files is malformed (bad",
  "    createRootRoute/createFileRoute call, wrong path string, or a syntax/type",
  "    error). FIX THE ROUTE FILE — the generated tree then resolves on the next",
  "    build. Every route file must `export const Route = createFileRoute('/path')`.",
  "  • LINKING to a DYNAMIC route — <Link>/navigate are TYPED against the route tree.",
  "    For a param route (src/routes/profile.$handle.tsx) pass the param SEPARATELY:",
  '    `<Link to="/profile/$handle" params={{ handle }}>` (and',
  '    `navigate({ to: "/tweet/$tweetId", params: { tweetId } })`). NEVER interpolate',
  "    the value into `to` — an interpolated template-literal string is NOT assignable",
  "    to the typed route union (TS2322). `to` is ALWAYS the static $param pattern; the",
  "    runtime value ALWAYS goes in `params`. The `params` KEY must match the route's",
  "    $segment EXACTLY (route /card/$cardId → params={{ cardId }}, not {{ id }}), and",
  "    `to` must name the route that HAS that param. A TS2353 `'X' does not exist in",
  "    type 'ParamsReducerFn<…>'` means your `to`/`params` disagree — fix `to` to the",
  "    right $param route (it is NOT a routeTree problem), do not restructure params.",
  "  • EVERY <Link to=…> / navigate({ to }) TARGET MUST BE A ROUTE FILE THAT EXISTS.",
  "    The typed route union is built ONLY from your src/routes/*.tsx files. An error",
  "    `Type '\"/x/create\"' is not assignable to '\"/\" | …'` (or `… not assignable to",
  "    parameter of type 'keyof FileRoutesByPath'`) does NOT mean edit the link string —",
  '    it means NO src/routes/x.create.tsx exists. A "New/Create X" button needs a real',
  "    route: create src/routes/<name>.create.tsx (and an edit page =",
  "    src/routes/<name>.$<id>.edit.tsx) BEFORE you link to it — OR render the form inline",
  "    / in a dialog and don't navigate at all. NEVER leave a Link pointing at a route you",
  "    have not created: it is an UNFIXABLE type error (you'll burn the whole turn budget",
  "    re-editing the string) until that route file exists. Pick one — make the route, or",
  "    don't link. And do NOT invent router hooks (there is no useRouteContext): read route",
  "    data only via the Route object — Route.useParams() / Route.useSearch() / useNavigate().",
  "  • UI BUILDING BLOCKS — call `scaffold_ui` ONCE near the start to generate what",
  "    the app needs, themed to its vibe (minimal | warm | futuristic, from the",
  "    user's request). Two tiers, BOTH from @/components/ui: PRIMITIVES (button,",
  "    card, input, label, textarea, select, badge, separator, skeleton, table) AND",
  "    COMPOSITION BLOCKS — app-shell (sidebar+nav layout, renders <Outlet/>), page-",
  "    header, field (label+control+error), form-actions, toolbar, empty-state. COMPOSE:",
  "    layout = app-shell; a list view = page-header + toolbar + table + empty-state;",
  "    a form = field × N + form-actions. NEVER hand-roll a component OR this view",
  "    chrome — it wastes time and breaks theme coherence. Write only feature wiring.",
  "    `table` is COLUMN-DRIVEN: `<Table columns={dealColumns} data={deals} rowKey={(d)",
  "    => d.id} />`, where `dealColumns: readonly IColumn<IDeal>[]` is a feature CONSTANT",
  "    (in <feature>.constants.ts). Each column is `{ header, cell: (row) => …, className? }`.",
  "    Do NOT build a per-feature table component — pass columns to the one <Table>.",
  "  • LOADING STATES ARE SKELETONS — every `isLoading`/`isPending` branch renders",
  "    `<Skeleton/>` (from @/components/ui/skeleton) SHAPED like the content it stands",
  "    in for: skeleton rows for a table, skeleton cards for a grid, a short skeleton",
  '    line for a heading. NEVER render `"Loading…"`/`"Loading"` text and NEVER a',
  "    spinner — the gate REJECTS loading text (no-loading-text-use-skeleton). Request",
  "    `skeleton` from scaffold_ui. Pattern: `if (isLoading) return <Skeleton className=",
  '    "h-9 w-full" />;` (size with Tailwind h-/w- classes; render several for a list).',
  "  • DATA LAYER — there is NO backend and NO scaffolded SDK/mock layer; you write",
  "    your own data access, and the gate holds it to the SAME strictness as any code",
  "    (no `as`, no eslint-disable). Two cases:",
  "      – LOCAL / DEMO data (the common case): define typed constants in",
  "        <feature>.constants.ts — `export const SEED_DEALS = [...] satisfies readonly",
  "        IDeal[]` (or annotate `: readonly IDeal[]`). Plain literals, no `as`; the",
  "        `satisfies`/annotation IS the validation. Render them directly. Write seed",
  "        data INDEX-FREE — no `arr[i]` (it's `T | undefined` under",
  "        noUncheckedIndexedAccess), no `id: `item-${i}``; just list the objects, or",
  "        build them with `Array.from({ length: N }, () => ({...}))` (no index param).",
  "      – ASYNC / fetch: @tanstack/react-query is installed and QueryClientProvider is",
  "        wired in src/main.tsx. Write your OWN hook in <feature>.hooks.ts — a",
  "        `useQuery`/`useMutation` wrapping `fetch` — returning typed data + isLoading +",
  "        error. The fetch response crosses `unknown`: NARROW it (a type guard / a",
  "        `switch` on a discriminant), do NOT `as`-cast it. Keep the hook in",
  "        <feature>.hooks.ts, never in a component body (no-state-in-component-body).",
  "      – LABEL / LOOKUP MAPS keyed by a union: TYPE the map `Record<TheUnion, V>` so",
  "        indexing by a union value is CAST-FREE — `const KIND_LABEL: Record<Kind, string>",
  "        = { call: 'Call', … }` → `KIND_LABEL[x.kind]` needs NO cast. NEVER write it as a",
  "        bare `as const` then index `MAP[key as keyof typeof MAP]` — that `as` is REJECTED.",
  "    So a feature is mostly: src/views/<Feature>/{<feature>.types.ts + a `satisfies`-typed",
  "    SEED/const in <feature>.constants.ts + index.tsx + components/}, plus a",
  "    <feature>.hooks.ts only if it has data fetching or derived state.",
  "  • Style with Tailwind classes via className using theme tokens",
  "    (bg-background, text-foreground, border-border), not raw colors.",
  "  • Need charts? `recharts` is installed — import from 'recharts'. Need drag-and-",
  "    drop? `@dnd-kit/core` + `@dnd-kit/sortable` are installed. Do NOT add other",
  "    deps (only these + the scaffold's are installed; the build can't fetch more).",
  "Imports use the @/ alias (e.g. @/views/<Feature>/<feature>.types, @/components/ui/button).",
  "Do NOT write a checks.json or browser-interaction/DOM test, and do NOT set up a",
  "test runner — `bun test` is ALREADY wired (the `test` script + @types/bun ship in",
  "package.json). The gate builds with Vite and renders in a real browser, FAILING on",
  "any runtime/console error — that IS the app's acceptance. SEPARATELY the harness",
  "enforces TDD on LOGIC: every `.ts` module that exports a function/class needs a",
  "co-located `<name>.test.ts` using bun:test —",
  '  `import { test, expect } from "bun:test"`.',
  "Presentational `.tsx` components need NO test. So put real logic (rules, reducers,",
  "derived state, formatting) in `.ts` modules and test those.",
  "Do NOT run `tsc`, `eslint`, `vite build`, or the gate command yourself to check",
  "your work — the harness type-checks each file the moment you write it and runs",
  "the full gate automatically, feeding back the exact errors concisely. Running",
  "them yourself just floods the conversation with output and wastes time. Just",
  "write and fix files; the harness tells you what's wrong. In particular the gate",
  "AUTO-FIXES all mechanical style for you — blank lines (padding-line-between-",
  "statements), `if` braces (curly), string→template (prefer-template), import order,",
  "and ALL formatting. NEVER re-run eslint/prettier or hand-fix those; they are not",
  "your job and you can ignore them entirely even if you happen to see them.",
  "WORK IN SMALL COHERENT SLICES — write ONE feature's few files per response (or a",
  "single file if it's large), then END the turn and let the harness check before you",
  "continue. This model is slow (~20 tokens/sec) and a response that runs past the time",
  "limit is CUT OFF and ALL of its work is LOST — so NEVER dump the whole app (all",
  "routes/components/seeds) into one giant response. A feature-sized slice finishes and",
  "accumulates; a huge turn fails. Build feature by feature — it is fine to take many",
  "turns. (Routes are the exception: create them ALL at once via `scaffold_routes`,",
  "since stubs are tiny and the complete route set must exist before you wire links.)",
].join("\n");

// ─── vanilla: Vite + TS + Tailwind, no framework ─────────────────────────────

const VANILLA_PACKAGE_JSON = `{
  "name": "app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "bun test"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/bun": "^1.3.14",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
`;

const VANILLA_VITE_CONFIG = `import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
});
`;

const VANILLA_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": [],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist", "build", "**/*.test.ts", "**/*.test.tsx"]
}
`;

const VANILLA_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>app</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

const VANILLA_MAIN_TS = `import "./style.css";

const app = document.getElementById("app");

if (app === null) {
  throw new Error("missing #app element");
}

const heading = document.createElement("h1");
heading.className = "text-3xl font-bold";
heading.textContent = "app";

const main = document.createElement("main");
main.className =
  "flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 text-gray-900";
main.append(heading);
app.append(main);
`;

const VANILLA_CSS = `@import "tailwindcss";
`;

const VANILLA_GUIDANCE = [
  "This is a Vite + TypeScript + Tailwind app (no UI framework) — ALREADY",
  "scaffolded and its dependencies INSTALLED. The entry is src/main.ts; it imports",
  "./style.css. Do NOT change vite.config.ts, index.html, or the build setup.",
  "STRUCTURE IT PROPERLY — small, single-purpose modules, NOT one big file:",
  "  • src/types.ts — shared types/interfaces",
  "  • src/store.ts — state + business logic (pure, NO DOM access)",
  "  • src/view.ts — DOM rendering (build/update elements with createElement)",
  "  • src/main.ts — the entry that wires store + view + events into #app",
  "Style with Tailwind utility classes. Keep functions small and single-purpose.",
  "Do NOT write a checks.json or browser-interaction/DOM test, and do NOT set up a",
  "test runner — `bun test` is ALREADY wired (the `test` script + @types/bun ship in",
  "package.json). The gate builds with Vite and renders in a real browser, failing on",
  "any runtime error — that IS the app's acceptance. SEPARATELY the harness enforces",
  "TDD on LOGIC: src/store.ts (pure, DOM-free) and any other `.ts` module that exports",
  "a function needs a co-located `<name>.test.ts` using bun:test —",
  '  `import { test, expect } from "bun:test"`.',
  "That is exactly why store logic is kept pure and out of view.ts — so it is",
  "unit-testable. Test the store; the entry/view need no test.",
].join("\n");

export const WEB_TEMPLATES: Record<WebFramework, IWebTemplate> = {
  react: {
    label: "Vite + React + shadcn/ui + TanStack",
    files: {
      "package.json": REACT_PACKAGE_JSON,
      "vite.config.ts": REACT_VITE_CONFIG,
      "tsconfig.json": REACT_TSCONFIG,
      "index.html": REACT_HTML,
      "components.json": COMPONENTS_JSON,
      "src/vite-env.d.ts": VITE_ENV_DTS,
      ".prettierignore": PRETTIER_IGNORE,
      "src/lib/utils.ts": CN_UTILS,
      "src/index.css": REACT_INDEX_CSS,
      "src/components/ui/button.tsx": BUTTON_TSX,
      "src/routes/__root.tsx": ROOT_ROUTE_TSX,
      "src/routes/index.tsx": INDEX_ROUTE_TSX,
      "src/routeTree.gen.ts": ROUTE_TREE_GEN,
      "src/main.tsx": REACT_MAIN_TSX,
    },
    // Ignored: the GENERATED route tree, the shadcn primitives, and the entry
    // wiring src/main.tsx (it carries TanStack's `declare module … interface
    // Register` augmentation — an external contract whose name we can't I-prefix).
    // The data layer (api/use-resource/use-form/mocks) is no longer scaffolded —
    // the model writes its own, gated like any code — and src/lib/utils.ts is
    // clean, editable, and linted like everything else.
    eslintIgnore: ["src/components/ui/**", "src/main.tsx", "**/*.gen.ts"],
    guidance: REACT_GUIDANCE,
  },
  vanilla: {
    label: "Vite + TypeScript + Tailwind",
    files: {
      "package.json": VANILLA_PACKAGE_JSON,
      "vite.config.ts": VANILLA_VITE_CONFIG,
      "tsconfig.json": VANILLA_TSCONFIG,
      "index.html": VANILLA_HTML,
      "src/vite-env.d.ts": VITE_ENV_DTS,
      ".prettierignore": PRETTIER_IGNORE,
      "src/main.ts": VANILLA_MAIN_TS,
      "src/style.css": VANILLA_CSS,
    },
    eslintIgnore: [],
    guidance: VANILLA_GUIDANCE,
  },
};
