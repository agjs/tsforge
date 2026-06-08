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
  "    `Route = createFileRoute('/<name>')({...})`; routeTree.gen.ts is GENERATED,",
  "    never edit it); shadcn/ui primitives stay in @/components/ui (Button exists;",
  "    add more there following cva + cn() + Tailwind tokens).",
  "  • Data/server state: TanStack Query (useQuery/useMutation) in <d>.hooks.ts;",
  "    a QueryClientProvider is already wired in src/main.tsx.",
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
      "src/lib/utils.ts": CN_UTILS,
      "src/index.css": REACT_INDEX_CSS,
      "src/components/ui/button.tsx": BUTTON_TSX,
      "src/routes/__root.tsx": ROOT_ROUTE_TSX,
      "src/routes/index.tsx": INDEX_ROUTE_TSX,
      "src/main.tsx": REACT_MAIN_TSX,
    },
    eslintIgnore: ["src/components/ui/**", "**/*.gen.ts"],
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
      "src/main.ts": VANILLA_MAIN_TS,
      "src/style.css": VANILLA_CSS,
    },
    eslintIgnore: [],
    guidance: VANILLA_GUIDANCE,
  },
};
