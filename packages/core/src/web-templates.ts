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
    "preview": "vite preview"
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

const INDEX_ROUTE_TSX = `import { createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background text-foreground">
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
  </StrictMode>
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
  "FILE LAYOUT — boringstack, ONE thing per file (judged on this, not just",
  "compiling). NEVER put more than one component in a file, and NEVER inline types",
  "or constants in a component file:",
  "  • Organize by DOMAIN: each feature/area of the app is its own folder under",
  "    src/, named for the domain it holds. Inside a domain folder <d>/ put:",
  "      – <d>.types.ts — that domain's interfaces/types (I-prefixed)",
  "      – <d>.constants.ts — its `as const` registries/config",
  "      – one component per .tsx file (PascalCase, named for the component)",
  "      – <d>.hooks.ts — its TanStack Query hooks",
  "      – index.ts — a barrel re-exporting the folder's public surface",
  "  • Types ALWAYS live in a `.types.ts`, constants in a `.constants.ts` — never",
  "    inline, and never one mega src/types.ts for the whole app. Types shared",
  "    across domains → src/shared/shared.types.ts.",
  "  • FIXED framework locations (exceptions to per-domain): routes go in",
  "    src/routes/<name>.tsx (TanStack file-based — exports",
  "    `Route = createFileRoute('/<name>')({...})`; shadcn/ui primitives stay in",
  "    @/components/ui (Button exists; add more there following cva + cn() + tokens).",
  "  • src/routeTree.gen.ts is AUTO-GENERATED by the Vite build from your route",
  "    files — NEVER create or edit it, and never try to fix it. If you see",
  "    `Cannot find module './routeTree.gen'` or `createFileRoute('/...')` →",
  "    `not assignable to parameter of type 'undefined'`, that is NOT a routeTree",
  "    problem: it means one of your src/routes/*.tsx files is malformed (bad",
  "    createRootRoute/createFileRoute call, wrong path string, or a syntax/type",
  "    error). FIX THE ROUTE FILE — the generated tree then resolves on the next",
  "    build. Every route file must `export const Route = createFileRoute('/path')`.",
  "  • UI BUILDING BLOCKS — call `scaffold_ui` ONCE near the start to generate what",
  "    the app needs, themed to its vibe (minimal | warm | futuristic, from the",
  "    user's request). Two tiers, BOTH from @/components/ui: PRIMITIVES (button,",
  "    card, input, label, textarea, select, badge, separator, table) AND COMPOSITION",
  "    BLOCKS — app-shell (sidebar+nav layout, renders <Outlet/>), page-header, field",
  "    (label+control+error), form-actions, toolbar, empty-state. COMPOSE these:",
  "    layout = app-shell; a list view = page-header + toolbar + table + empty-state;",
  "    a form = field × N + form-actions. NEVER hand-roll a component OR this view",
  "    chrome — it wastes time and breaks theme coherence. Write only domain wiring.",
  "  • HARNESS SDK — USE IT, do NOT hand-roll the data layer (this is the biggest",
  "    speed+quality lever). A tested generic toolkit is already in src/lib/:",
  "      – createCollection(key, SEED, parseFn) [from @/lib/collection] IS a domain's",
  "        whole service: typed async CRUD + Result + latency. <d>.service.ts is ONE",
  "        line: `export const items = createCollection('items', SEED_ITEMS, parseItem)`.",
  "      – useCollection(collection) [from @/lib/use-collection] IS the data hook:",
  "        cached list, isLoading/error, and create/update/remove mutations WITH",
  "        optimistic updates + rollback. Do NOT write a <d>.hooks.ts query wrapper.",
  "      – useForm({ initial, validate, submit }) [from @/lib/use-form] IS form state:",
  "        values, per-field errors, async submit status. Do NOT hand-roll form state.",
  "      – parse combinators [from @/lib/parse]: pObject/pString/pNumber/pLiteral/",
  "        pArray build a validator in a few lines: `const parseDeal = pObject({...})`.",
  "      – Result/ok/err [from @/lib/result] for any fallible op.",
  "      – objectKeys(x)/objectEntries(x) [from @/lib/object] for TYPED keys of an",
  "        `as const` object. NEVER write `Object.keys(x) as (keyof typeof x)[]` —",
  "        the gate REJECTS that `as` cast; call objectKeys(x) instead.",
  "      – sortBy(rows, key, dir) [from @/lib/sort] for sortable tables/lists: pass",
  "        the column key as a plain STRING, get a sorted copy. NEVER write",
  "        `[...rows].sort((a, b) => a[sortKey] - b[sortKey])` — a string can't index",
  "        an entity (TS7053) and the `as` to silence it is banned. sortBy does it safely.",
  "    So a domain is mostly: <d>.types.ts + a SEED const + a parse<X> + one-line",
  "    createCollection + components that call useCollection/useForm. Far fewer lines,",
  "    fewer bugs. Only write a custom service/hook if the SDK genuinely can't express",
  "    it. A QueryClientProvider is already wired in src/main.tsx.",
  "  • Style with Tailwind classes via className using theme tokens",
  "    (bg-background, text-foreground, border-border), not raw colors.",
  "  • Need charts? `recharts` is installed — import from 'recharts'. Need drag-and-",
  "    drop? `@dnd-kit/core` + `@dnd-kit/sortable` are installed. Do NOT add other",
  "    deps (only these + the scaffold's are installed; the build can't fetch more).",
  "Imports use the @/ alias (e.g. @/<domain>/<domain>.types, @/components/ui/button).",
  "Do NOT write a checks.json or any browser interaction test. The gate already",
  "builds the app with Vite and renders it in a real browser, FAILING on any",
  "runtime/console error — that IS the acceptance. Spend your effort on a working,",
  "clean app that renders without errors, not on test assertions.",
  "Do NOT run `tsc`, `eslint`, `vite build`, or the gate command yourself to check",
  "your work — the harness type-checks each file the moment you write it and runs",
  "the full gate automatically, feeding back the exact errors concisely. Running",
  "them yourself just floods the conversation with output and wastes time. Just",
  "write and fix files; the harness tells you what's wrong.",
].join("\n");

// ─── vanilla: Vite + TS + Tailwind, no framework ─────────────────────────────

const VANILLA_PACKAGE_JSON = `{
  "name": "app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
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
  "Do NOT write a checks.json or browser interaction test. The gate builds with",
  "Vite and renders the app in a real browser, failing on any runtime error — that",
  "is the acceptance. Focus on a working app that renders cleanly.",
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

const SDK_PARSE_TS = `// A tiny parser combinator — declarative, Result-returning validators so a domain's
// validation is a few composable lines, not a hand-rolled 40-line type guard. Parse
// genuinely-external data at the boundary; createCollection parses seed for you.
import type { Result } from "@/lib/result";
import { err, ok } from "@/lib/result";

export type Parser<T> = (input: unknown) => Result<T, string>;

export const pString: Parser<string> = (input) =>
  typeof input === "string" ? ok(input) : err("expected string");

export const pNumber: Parser<number> = (input) =>
  typeof input === "number" && Number.isFinite(input)
    ? ok(input)
    : err("expected number");

export const pBoolean: Parser<boolean> = (input) =>
  typeof input === "boolean" ? ok(input) : err("expected boolean");

export function pLiteral<const T extends string>(...allowed: readonly T[]): Parser<T> {
  return (input) =>
    typeof input === "string" && allowed.includes(input as T)
      ? ok(input as T)
      : err("expected one of " + allowed.join(", "));
}

export function pArray<T>(item: Parser<T>): Parser<readonly T[]> {
  return (input) => {
    if (!Array.isArray(input)) {
      return err("expected array");
    }
    const out: T[] = [];
    for (const raw of input) {
      const parsed = item(raw);
      if (!parsed.ok) {
        return parsed;
      }
      out.push(parsed.value);
    }
    return ok(out);
  };
}

export function pObject<T extends Record<string, unknown>>(shape: {
  readonly [K in keyof T]: Parser<T[K]>;
}): Parser<T> {
  return (input) => {
    if (typeof input !== "object" || input === null) {
      return err("expected object");
    }
    const record = input as Record<string, unknown>;
    const out: Partial<T> = {};
    for (const key in shape) {
      const parsed = shape[key](record[key]);
      if (!parsed.ok) {
        return err(key + ": " + parsed.error);
      }
      out[key] = parsed.value;
    }
    return ok(out as T);
  };
}
`;

const SDK_COLLECTION_TS = `// createCollection — one tested generic that IS a domain's data layer: typed async
// CRUD over an in-memory store, parsing seed data through a Parser, with simulated
// latency + a Result return. A domain's service becomes one line:
//   export const items = createCollection("items", SEED, parseItem)
import type { Parser } from "@/lib/parse";
import type { Result } from "@/lib/result";
import { err, ok } from "@/lib/result";

export interface IEntity {
  readonly id: string;
}

export interface ICollection<T extends IEntity> {
  readonly key: string;
  list: () => Promise<Result<readonly T[], string>>;
  get: (id: string) => Promise<Result<T, string>>;
  create: (draft: Omit<T, "id">) => Promise<Result<T, string>>;
  update: (id: string, patch: Partial<Omit<T, "id">>) => Promise<Result<T, string>>;
  remove: (id: string) => Promise<Result<true, string>>;
}

const LATENCY_MS = 120;

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
}

export function createCollection<T extends IEntity>(
  key: string,
  seed: readonly unknown[],
  parse: Parser<T>
): ICollection<T> {
  const store = new Map<string, T>();
  for (const raw of seed) {
    const parsed = parse(raw);
    if (parsed.ok) {
      store.set(parsed.value.id, parsed.value);
    }
  }

  let counter = store.size;
  const nextId = (): string => {
    counter += 1;
    return key + "-" + String(counter);
  };

  return {
    key,
    async list() {
      await delay();
      return ok([...store.values()]);
    },
    async get(id) {
      await delay();
      const found = store.get(id);
      return found === undefined ? err(key + " " + id + " not found") : ok(found);
    },
    async create(draft) {
      await delay();
      const entity = { ...draft, id: nextId() } as T;
      store.set(entity.id, entity);
      return ok(entity);
    },
    async update(id, patch) {
      await delay();
      const current = store.get(id);
      if (current === undefined) {
        return err(key + " " + id + " not found");
      }
      const updated = { ...current, ...patch };
      store.set(id, updated);
      return ok(updated);
    },
    async remove(id) {
      await delay();
      return store.delete(id) ? ok(true) : err(key + " " + id + " not found");
    },
  };
}
`;

const SDK_USE_COLLECTION_TS = `// useCollection — the TanStack Query layer for a collection, once: cached list,
// loading/error state, and create/update/remove mutations with OPTIMISTIC updates
// + rollback + invalidation built in. A domain's hooks file becomes one line.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ICollection, IEntity } from "@/lib/collection";

export interface IMutationApi<T extends IEntity> {
  create: (draft: Omit<T, "id">) => void;
  update: (input: { readonly id: string; readonly patch: Partial<Omit<T, "id">> }) => void;
  remove: (id: string) => void;
  isPending: boolean;
}

export interface ICollectionApi<T extends IEntity> {
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

export function useCollection<T extends IEntity>(collection: ICollection<T>): ICollectionApi<T> {
  const client = useQueryClient();
  const queryKey = [collection.key];

  const query = useQuery({
    queryKey,
    queryFn: () => unwrap(collection.list()),
  });

  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey });
  };

  const create = useMutation({
    mutationFn: (draft: Omit<T, "id">) => unwrap(collection.create(draft)),
    onSettled: invalidate,
  });

  const update = useMutation({
    mutationFn: (input: { readonly id: string; readonly patch: Partial<Omit<T, "id">> }) =>
      unwrap(collection.update(input.id, input.patch)),
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
    mutationFn: (id: string) => unwrap(collection.remove(id)),
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
      "src/lib/parse.ts": SDK_PARSE_TS,
      "src/lib/collection.ts": SDK_COLLECTION_TS,
      "src/lib/use-collection.ts": SDK_USE_COLLECTION_TS,
      "src/lib/use-form.ts": SDK_USE_FORM_TS,
      "src/index.css": REACT_INDEX_CSS,
      "src/components/ui/button.tsx": BUTTON_TSX,
      "src/routes/__root.tsx": ROOT_ROUTE_TSX,
      "src/routes/index.tsx": INDEX_ROUTE_TSX,
      "src/routeTree.gen.ts": ROUTE_TREE_GEN,
      "src/main.tsx": REACT_MAIN_TSX,
    },
    eslintIgnore: ["src/components/ui/**", "src/lib/**", "**/*.gen.ts"],
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
