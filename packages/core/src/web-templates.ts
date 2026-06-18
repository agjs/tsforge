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
 * shadcn components + the generated routeTree.gen.ts are VENDORED/GENERATED — not
 * the model's output — so each stack lists `eslintIgnore` globs that exempt them
 * from the bundled strict eslint (they're still type-checked by tsc + vite build).
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
src/lib
src/mocks/db.ts
src/mocks/browser.ts
public/mockServiceWorker.js
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
    "@faker-js/faker": "^9.5.0",
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
    "msw": "^2.7.0",
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
    tsconfigPaths(),
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
  "exclude": ["node_modules", "dist", "build"]
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

import { worker } from "./mocks/browser";
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

const root = createRoot(rootElement);

// Start the MSW mock API BEFORE mounting — there is no real backend, so the app's
// fetches must be intercepted from the very first render (in dev AND in the build).
async function start(): Promise<void> {
  await worker.start({ onUnhandledRequest: "bypass", quiet: true });

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
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
  "      – (NO <feature>.hooks.ts query wrapper — the SDK's useResource IS the data",
  "        hook; add a hook file ONLY for genuine derived/computed state, never to fetch.)",
  "  • A component .tsx (index.tsx or components/<X>.tsx) = imports + the component,",
  "    nothing else. A constant (label map, column spec) → <feature>.constants.ts. A type",
  "    → <feature>.types.ts (shared across features → src/shared/shared.types.ts). A pure",
  "    helper (formatCurrency, timeAgo) → src/lib/<name>.ts. Putting any of these atop a",
  "    component is a GATE ERROR (component-file-purity / component-folder-structure).",
  "  • Shared, reusable UI primitives live in @/components/ui (scaffold_ui) — they are",
  "    feature-agnostic. Anything feature-specific is a view component, never a primitive.",
  "  • NO RUNTIME VALIDATION / PARSING — there is NO backend, network, or uploaded",
  "    data here; EVERY value originates from your own typed code + seed, so TypeScript",
  "    has already proven its shape. The TYPE SYSTEM is the only validation. NEVER create",
  "    a `*.validators.ts`; NEVER write a `parse<X>` / `validate<X>` / `is<X>` function",
  "    that takes `unknown` or `Record<string, unknown>` and checks fields with `typeof`",
  "    / `in` — that is dead ceremony for data the compiler already guarantees, and it is",
  "    REJECTED. Instead: type the value correctly at its source and use it directly; for",
  "    a literal use `x satisfies IType`; narrow a discriminated union with a plain",
  "    `switch (x.kind)`. If you typed it right, there is nothing to validate.",
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
  "  • DATA LAYER — a REAL mock API (MSW), do NOT hand-roll it (biggest speed+quality",
  "    lever). The app does REAL `fetch()` to REST endpoints intercepted in-browser by",
  "    Mock Service Worker — already wired and started in src/main.tsx. Two vendored",
  "    generics (in src/lib + src/mocks; NEVER edit them — a type error involving them",
  "    is a wrong CALL SITE) give you the whole loop in two lines per feature:",
  "      – REGISTER the endpoint: in src/mocks/handlers.ts add ONE line —",
  "        `...mockResource('/api/deals', SEED_DEALS)` [mockResource from @/mocks/db].",
  "        It serves GET (list), GET /:id, POST, PATCH /:id, DELETE /:id over an in-",
  "        memory faker-seeded store. handlers.ts is the ONLY mock file you edit.",
  "      – CONSUME it: `const { items, isLoading, error, mutations } =",
  "        useResource<IDeal>('/api/deals')` [useResource from @/lib/use-resource] IS",
  "        the data hook — cached list, isLoading/error, and create/update/remove",
  "        mutations WITH optimistic updates + rollback. Pass the SAME path string you",
  "        registered. Do NOT write a <feature>.hooks.ts query wrapper or call fetch",
  "        yourself — useResource is the only data access.",
  "      – useForm({ initial, validate, submit }) [from @/lib/use-form] IS form state:",
  "        values, per-field errors, async submit status. Do NOT hand-roll form state.",
  "      – SEED DATA — GENERATE with faker. NEVER hand-write literal arrays, and NEVER",
  "        index (no Array.from((_,i)=>…), no `arr[i]`, no `id:`item-${i}``, no `pickX(i)`",
  "        helpers). Indexing is the root of all the garbage: `arr[i]` is T | undefined",
  "        under noUncheckedIndexedAccess, which then forces `if (x===undefined) throw`",
  "        guards. There is NO index. Build the seed INDEX-FREE with two faker helpers:",
  "          • `faker.helpers.multiple(factory, { count: N })` — runs the factory N times,",
  "            no counter. The factory's RETURN-TYPE annotation is the whole validation.",
  "          • `faker.helpers.arrayElement(arr)` — picks one element, returns T (NOT T |",
  "            undefined), for fixed sets / string-literal unions / RELATED seed arrays.",
  "        `faker.string.uuid()` for ids. Pattern:",
  "          `faker.seed(42);`",
  "          `export const SEED_NOTIFS: readonly INotif[] = faker.helpers.multiple(`",
  "          `  (): INotif => ({ id: faker.string.uuid(), kind: faker.helpers.arrayElement(`",
  "          `    ['like','reply','follow']), from: faker.helpers.arrayElement(SEED_USERS),`",
  "          `    text: faker.lorem.sentence() }), { count: 15 });`",
  "        No `i`, no `arr[i % len]`, no undefined-guards, no parser — the type system +",
  "        the factory return type ARE the validation. Define each SEED in the view's",
  "        <feature>.constants.ts and pass it to mockResource. The mock API echoes your",
  "        typed SEED and useResource<T> types the response, so the contract is proven",
  "        end-to-end — NEVER write a runtime parser/validator (no parse<X>, no pObject,",
  "        no `typeof` guards, no `as` casts) even though it now crosses a fetch.",
  "      – Result/ok/err [from @/lib/result] for any fallible op.",
  "      – objectKeys(x)/objectEntries(x) [from @/lib/object] for TYPED keys of an",
  "        `as const` object. NEVER write `Object.keys(x) as (keyof typeof x)[]` —",
  "        the gate REJECTS that `as` cast; call objectKeys(x) instead.",
  "      – sortBy(rows, key, dir) [from @/lib/sort] for sortable tables/lists: pass",
  "        the column key as a plain STRING, get a sorted copy. NEVER write",
  "        `[...rows].sort((a, b) => a[sortKey] - b[sortKey])` — a string can't index",
  "        an entity (TS7053) and the `as` to silence it is banned. sortBy does it safely.",
  "      – LABEL / LOOKUP MAPS (status→label, kind→color, etc.) keyed by a union: TYPE",
  "        the map `Record<TheUnion, V>` so indexing by a value of that union is CAST-FREE.",
  "        e.g. `const KIND_LABEL: Record<ActivityKind, string> = { call: 'Call', … }` →",
  "        `KIND_LABEL[activity.kind]` needs NO cast. NEVER write the map as a bare",
  "        `as const` and then index it `MAP[key as keyof typeof MAP]` — that `as` is",
  "        REJECTED. The map's KEY type, not a cast, is what makes the lookup type-check.",
  "    So a feature is mostly: src/views/<Feature>/{<feature>.types.ts + a `satisfies`-typed",
  "    SEED const in <feature>.constants.ts + index.tsx + components/}, plus ONE",
  "    `mockResource('/api/x', SEED)` line in src/mocks/handlers.ts, calling",
  "    useResource/useForm. Far fewer lines, fewer bugs. Only write a custom hook if the",
  "    SDK genuinely can't express it. QueryClientProvider + the MSW worker are already",
  "    wired in src/main.tsx.",
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
  "exclude": ["node_modules", "dist", "build"]
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

// ── Harness SDK primitives (vendored): the toolkit the model COMPOSES with
// instead of hand-writing per-domain services/hooks/forms/validators. One
// tested generic each — quality UP, tokens DOWN. *.gen-style vendored code.
const SDK_RESULT_TS = `// A Result type + constructors — the harness SDK's error spine. Fallible operations
// return Result instead of throwing, so callers handle failure explicitly.
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
`;

const SDK_OBJECT_TS = `// Typed Object helpers. This vendored, lint-exempt file is the ONE sanctioned home
// for the Object.keys cast. In YOUR code use objectKeys(x) instead of
// \`Object.keys(x) as (keyof typeof x)[]\` — the strict gate rejects that cast.
export function objectKeys<T extends object>(obj: T): (keyof T)[] {
  return Object.keys(obj) as (keyof T)[];
}

export function objectEntries<T extends object>(obj: T): [keyof T, T[keyof T]][] {
  return Object.entries(obj) as [keyof T, T[keyof T]][];
}
`;

const SDK_SORT_TS = `// Typed sorting for tables/lists. The strict gate rejects \`row[sortKey]\` when
// sortKey is a string (TS7053: a string can't index an entity), and bans the \`as\`
// cast that would silence it. This vendored, lint-exempt helper does the indexing
// safely ONCE here: pass the column key as a plain string and get a sorted COPY
// (handles readonly input → mutable output). In YOUR code:
//   const rows = sortBy(transactions, sortKey, sortDir)  // sortKey: string is fine
// — never write \`[...rows].sort((a, b) => a[sortKey] - b[sortKey])\`.
export function sortBy<T extends object>(
  rows: readonly T[],
  key: string,
  direction: "asc" | "desc" = "asc"
): T[] {
  const dir = direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];

    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * dir;
    }

    return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
  });
}
`;

const SDK_API_TS = `// The typed fetch client — every data op goes over a REAL network call to a REST
// endpoint, intercepted in-browser by MSW (see src/mocks/). Returns Result instead
// of throwing, so callers handle failure explicitly. This is vendored + lint-exempt
// (the boundary cast on the JSON body lives here, ONCE — your code never casts).
import type { Result } from "@/lib/result";
import { err, ok } from "@/lib/result";

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<Result<T, string>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      return err(method + " " + path + " failed: " + String(res.status));
    }

    if (res.status === 204) {
      return ok(undefined as T);
    }

    return ok((await res.json()) as T);
  } catch (error) {
    return err(error instanceof Error ? error.message : "network error");
  }
}

export function apiGet<T>(path: string): Promise<Result<T, string>> {
  return request<T>("GET", path);
}

export function apiPost<T>(path: string, body: unknown): Promise<Result<T, string>> {
  return request<T>("POST", path, body);
}

export function apiPatch<T>(path: string, body: unknown): Promise<Result<T, string>> {
  return request<T>("PATCH", path, body);
}

export function apiDelete(path: string): Promise<Result<true, string>> {
  return request<true>("DELETE", path);
}
`;

const SDK_USE_RESOURCE_TS = `// useResource — the TanStack Query layer for a REST resource, once: cached list,
// loading/error state, and create/update/remove mutations with OPTIMISTIC updates
// + rollback + invalidation built in. Pass the resource's base path (the same one
// you registered with mockResource in src/mocks/handlers.ts):
//   const { items, isLoading, mutations } = useResource<IDeal>("/api/deals")
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

export interface IEntity {
  readonly id: string;
}

export interface IMutationApi<T extends IEntity> {
  create: (draft: Omit<T, "id">) => void;
  update: (input: { readonly id: string; readonly patch: Partial<Omit<T, "id">> }) => void;
  remove: (id: string) => void;
  isPending: boolean;
}

export interface IResourceApi<T extends IEntity> {
  items: readonly T[];
  isLoading: boolean;
  error: string | undefined;
  refetch: () => void;
  mutations: IMutationApi<T>;
}

async function unwrap<T>(promise: Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<T> {
  const result = await promise;
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

export function useResource<T extends IEntity>(path: string): IResourceApi<T> {
  const client = useQueryClient();
  const queryKey = [path];

  const query = useQuery({
    queryKey,
    queryFn: () => unwrap(apiGet<readonly T[]>(path)),
  });

  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey });
  };

  const create = useMutation({
    mutationFn: (draft: Omit<T, "id">) => unwrap(apiPost<T>(path, draft)),
    onSettled: invalidate,
  });

  const update = useMutation({
    mutationFn: (input: { readonly id: string; readonly patch: Partial<Omit<T, "id">> }) =>
      unwrap(apiPatch<T>(path + "/" + input.id, input.patch)),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<readonly T[]>(queryKey);
      if (previous !== undefined) {
        client.setQueryData<readonly T[]>(
          queryKey,
          previous.map((item) => (item.id === input.id ? { ...item, ...input.patch } : item))
        );
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) {
        client.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => unwrap(apiDelete(path + "/" + id)),
    onSettled: invalidate,
  });

  return {
    items: query.data ?? [],
    isLoading: query.isPending,
    error: query.error === null ? undefined : query.error.message,
    refetch: () => {
      void query.refetch();
    },
    mutations: {
      create: create.mutate,
      update: update.mutate,
      remove: remove.mutate,
      isPending: create.isPending || update.isPending || remove.isPending,
    },
  };
}
`;

const SDK_MOCKS_DB_TS = `// mockResource — one tested generic that IS a REST endpoint set: in-memory CRUD
// over a faker-seeded store, exposed as MSW handlers. Registering a resource is one
// line in src/mocks/handlers.ts:
//   ...mockResource("/api/deals", SEED_DEALS)
// It serves GET (list), GET /:id, POST, PATCH /:id, DELETE /:id. Vendored + lint-
// exempt (the boundary casts on request bodies live here, ONCE). NEVER edit this.
import { http, HttpResponse, type RequestHandler } from "msw";
import { faker } from "@faker-js/faker";

export interface IEntity {
  readonly id: string;
}

export function mockResource<T extends IEntity>(
  path: string,
  seed: readonly T[]
): RequestHandler[] {
  const store = new Map<string, T>();
  for (const entity of seed) {
    store.set(entity.id, entity);
  }

  return [
    http.get(path, () => HttpResponse.json([...store.values()])),
    http.get(path + "/:id", ({ params }) => {
      const found = store.get(String(params.id));
      return found === undefined
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.json(found);
    }),
    http.post(path, async ({ request }) => {
      const draft = (await request.json()) as Omit<T, "id">;
      const entity = { ...draft, id: faker.string.uuid() } as T;
      store.set(entity.id, entity);
      return HttpResponse.json(entity, { status: 201 });
    }),
    http.patch(path + "/:id", async ({ params, request }) => {
      const current = store.get(String(params.id));
      if (current === undefined) {
        return new HttpResponse(null, { status: 404 });
      }
      const patch = (await request.json()) as Partial<Omit<T, "id">>;
      const updated = { ...current, ...patch };
      store.set(updated.id, updated);
      return HttpResponse.json(updated);
    }),
    http.delete(path + "/:id", ({ params }) => {
      const existed = store.delete(String(params.id));
      return new HttpResponse(null, { status: existed ? 204 : 404 });
    }),
  ];
}
`;

const SDK_MOCKS_BROWSER_TS = `// The MSW worker, wired from your handlers. Vendored — NEVER edit. Register your
// resources in src/mocks/handlers.ts; main.tsx starts this before the app mounts.
import { setupWorker } from "msw/browser";
import { handlers } from "@/mocks/handlers";

export const worker = setupWorker(...handlers);
`;

const MOCKS_HANDLERS_TS = `// YOUR mock API. Register each resource here with mockResource (one line per
// resource), passing your faker-generated SEED. This is the ONLY mock file you
// edit — src/mocks/db.ts and src/mocks/browser.ts are vendored.
//   import { mockResource } from "@/mocks/db";
//   import { SEED_DEALS } from "@/views/Deals/deals.constants";
//   export const handlers: RequestHandler[] = [...mockResource("/api/deals", SEED_DEALS)];
import { type RequestHandler } from "msw";

export const handlers: RequestHandler[] = [];
`;

const SDK_USE_FORM_TS = `// useForm — declarative form state: values, per-field errors, async submit with
// loading/success/error status. A form becomes initial + validate + submit; the
// plumbing (touched, submitting, error/success handling) lives here, once.
import { useCallback, useState } from "react";
import type { Result } from "@/lib/result";

export type TFormStatus = "idle" | "submitting" | "success" | "error";
export type TFieldErrors<T> = Partial<Record<keyof T, string>>;

export interface IFormApi<T> {
  values: T;
  errors: TFieldErrors<T>;
  status: TFormStatus;
  submitError: string | undefined;
  setField: <K extends keyof T>(key: K, value: T[K]) => void;
  handleSubmit: () => Promise<void>;
}

export interface IFormOptions<T> {
  readonly initial: T;
  readonly validate: (values: T) => TFieldErrors<T>;
  readonly submit: (values: T) => Promise<Result<unknown, string>>;
}

export function useForm<T>(options: IFormOptions<T>): IFormApi<T> {
  const [values, setValues] = useState<T>(options.initial);
  const [errors, setErrors] = useState<TFieldErrors<T>>({});
  const [status, setStatus] = useState<TFormStatus>("idle");
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);

  const setField = useCallback(<K extends keyof T>(key: K, value: T[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = useCallback(async (): Promise<void> => {
    const found = options.validate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    setStatus("submitting");
    setSubmitError(undefined);
    const result = await options.submit(values);
    if (result.ok) {
      setStatus("success");
    } else {
      setStatus("error");
      setSubmitError(result.error);
    }
  }, [options, values]);

  return { values, errors, status, submitError, setField, handleSubmit };
}
`;

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
      "src/lib/result.ts": SDK_RESULT_TS,
      "src/lib/object.ts": SDK_OBJECT_TS,
      "src/lib/sort.ts": SDK_SORT_TS,
      "src/lib/api.ts": SDK_API_TS,
      "src/lib/use-resource.ts": SDK_USE_RESOURCE_TS,
      "src/lib/use-form.ts": SDK_USE_FORM_TS,
      "src/mocks/db.ts": SDK_MOCKS_DB_TS,
      "src/mocks/browser.ts": SDK_MOCKS_BROWSER_TS,
      "src/mocks/handlers.ts": MOCKS_HANDLERS_TS,
      "src/index.css": REACT_INDEX_CSS,
      "src/components/ui/button.tsx": BUTTON_TSX,
      "src/routes/__root.tsx": ROOT_ROUTE_TSX,
      "src/routes/index.tsx": INDEX_ROUTE_TSX,
      "src/routeTree.gen.ts": ROUTE_TREE_GEN,
      "src/main.tsx": REACT_MAIN_TSX,
    },
    eslintIgnore: [
      "src/components/ui/**",
      "src/lib/**",
      "src/mocks/db.ts",
      "src/mocks/browser.ts",
      "public/mockServiceWorker.js",
      "**/*.gen.ts",
    ],
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
