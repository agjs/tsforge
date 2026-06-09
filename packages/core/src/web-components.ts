/**
 * THEMED COMPONENT MATERIALIZATION — the harness holds tested primitive STRUCTURE
 * and a set of VIBE themes; the model calls one tool (`scaffold_ui`) to get a
 * coherent component set without authoring (or re-authoring) any of it. Two layers,
 * both hardcoded:
 *
 *   1. tokens  — a design-token block (`:root` palette + `--radius`) written into
 *      `index.css`. THE big lever: every primitive references semantic classes
 *      (`bg-card`, `rounded-md`), so swapping the token preset reskins the whole set
 *      coherently (minimal = neutral; warm = amber + round; futuristic = cool-neon +
 *      sharp). One block decides ~90% of the look.
 *   2. deltas  — optional per-component extra classes, merged via `cn(...)` into the
 *      primitive's root for finer per-vibe identity. STRUCTURE is invariant; only
 *      these classes vary, and most are empty (the tokens carry the vibe).
 *
 * The SDK philosophy applied to UI: tested structure + a parameterized surface. The
 * model writes app logic, never plumbing. All primitives are dependency-free (plain
 * HTML elements + cva), so a scaffolded project needs no extra Radix install and the
 * set stays offline-testable. They land under `src/components/ui/` (eslint-ignored,
 * vite tree-shakes unused ones from the bundle).
 */

/** The vibes the model can request. */
export type ThemeName = "minimal" | "warm" | "futuristic";

/** The primitives `scaffold_ui` can materialize. */
export type ComponentName =
  // primitives (atoms)
  | "button"
  | "card"
  | "input"
  | "label"
  | "textarea"
  | "select"
  | "badge"
  | "separator"
  | "table"
  // composition blocks (molecules) — the view chrome the model otherwise re-rolls
  | "app-shell"
  | "page-header"
  | "field"
  | "form-actions"
  | "toolbar"
  | "empty-state";

export const COMPONENT_NAMES: readonly ComponentName[] = [
  "button",
  "card",
  "input",
  "label",
  "textarea",
  "select",
  "badge",
  "separator",
  "table",
  "app-shell",
  "page-header",
  "field",
  "form-actions",
  "toolbar",
  "empty-state",
];

export const THEME_NAMES: readonly ThemeName[] = [
  "minimal",
  "warm",
  "futuristic",
];

export interface ITheme {
  name: ThemeName;
  /** The `index.css` token block (Tailwind import + `:root` + `@theme`). */
  tokens: string;
  /** Per-component extra classes merged into the root via `cn`. Missing ⇒ none. */
  deltas: Partial<Record<ComponentName, string>>;
}

// ─── token presets (the vibe lever) ──────────────────────────────────────────

function tokenBlock(vars: string): string {
  return `@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

:root {
${vars}
}

@theme inline {
  --radius-sm: calc(var(--radius) - 2px);
  --radius-md: var(--radius);
  --radius-lg: calc(var(--radius) + 2px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
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
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
`;
}

const VARS_MINIMAL = `  --radius: 0.5rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
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
  --ring: oklch(0.708 0 0);`;

const VARS_WARM = `  --radius: 0.875rem;
  --background: oklch(0.99 0.01 85);
  --foreground: oklch(0.24 0.03 50);
  --card: oklch(0.98 0.02 85);
  --card-foreground: oklch(0.24 0.03 50);
  --primary: oklch(0.66 0.16 50);
  --primary-foreground: oklch(0.99 0.01 85);
  --secondary: oklch(0.94 0.04 80);
  --secondary-foreground: oklch(0.34 0.05 50);
  --muted: oklch(0.95 0.03 85);
  --muted-foreground: oklch(0.52 0.04 55);
  --accent: oklch(0.9 0.07 75);
  --accent-foreground: oklch(0.32 0.06 50);
  --destructive: oklch(0.58 0.22 25);
  --border: oklch(0.89 0.04 80);
  --input: oklch(0.89 0.04 80);
  --ring: oklch(0.66 0.16 50);`;

const VARS_FUTURISTIC = `  --radius: 0rem;
  --background: oklch(0.16 0.02 265);
  --foreground: oklch(0.96 0.01 260);
  --card: oklch(0.21 0.03 265);
  --card-foreground: oklch(0.96 0.01 260);
  --primary: oklch(0.72 0.18 195);
  --primary-foreground: oklch(0.16 0.02 265);
  --secondary: oklch(0.27 0.03 265);
  --secondary-foreground: oklch(0.96 0.01 260);
  --muted: oklch(0.27 0.03 265);
  --muted-foreground: oklch(0.72 0.02 260);
  --accent: oklch(0.32 0.06 300);
  --accent-foreground: oklch(0.96 0.01 260);
  --destructive: oklch(0.62 0.24 18);
  --border: oklch(0.4 0.05 265);
  --input: oklch(0.3 0.04 265);
  --ring: oklch(0.72 0.18 195);`;

export const THEMES: Record<ThemeName, ITheme> = {
  minimal: { name: "minimal", tokens: tokenBlock(VARS_MINIMAL), deltas: {} },
  warm: {
    name: "warm",
    tokens: tokenBlock(VARS_WARM),
    deltas: { card: "shadow-sm", button: "shadow-sm" },
  },
  futuristic: {
    name: "futuristic",
    tokens: tokenBlock(VARS_FUTURISTIC),
    deltas: {
      button: "uppercase tracking-wide",
      card: "backdrop-blur-sm",
      input: "font-mono",
      textarea: "font-mono",
      select: "font-mono",
      label: "uppercase tracking-wider text-xs",
      badge: "uppercase tracking-wide",
    },
  },
};

// ─── primitive STRUCTURE (invariant) — `$DELTA` becomes the theme's classes ─────

const PRIMITIVES: Record<ComponentName, string> = {
  button: `import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 $DELTA",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
      },
      size: { default: "h-9 px-4 py-2", sm: "h-8 px-3", lg: "h-10 px-6", icon: "size-9" },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface IButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  className,
  variant,
  size,
  ...props
}: IButtonProps): React.JSX.Element {
  return (
    <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
`,
  card: `import { cn } from "@/lib/utils";

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground p-6 $DELTA",
        className
      )}
      {...props}
    />
  );
}
`,
  input: `import { cn } from "@/lib/utils";

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 $DELTA",
        className
      )}
      {...props}
    />
  );
}
`,
  label: `import { cn } from "@/lib/utils";

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return (
    <label
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 $DELTA",
        className
      )}
      {...props}
    />
  );
}
`,
  textarea: `import { cn } from "@/lib/utils";

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return (
    <textarea
      className={cn(
        "flex min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 $DELTA",
        className
      )}
      {...props}
    />
  );
}
`,
  select: `import { cn } from "@/lib/utils";

export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 $DELTA",
        className
      )}
      {...props}
    />
  );
}
`,
  badge: `import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium $DELTA",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        destructive: "border-transparent bg-destructive text-white",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface IBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({
  className,
  variant,
  ...props
}: IBadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
`,
  separator: `import { cn } from "@/lib/utils";

export function Separator({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      role="separator"
      className={cn("shrink-0 bg-border h-px w-full $DELTA", className)}
      {...props}
    />
  );
}
`,
  table: `import { cn } from "@/lib/utils";

export function Table({
  className,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>): React.JSX.Element {
  return (
    <div className="relative w-full overflow-auto $DELTA">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <thead className={cn("[&_tr]:border-b", className)} {...props} />;
}

export function TableBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement>): React.JSX.Element {
  return (
    <tr
      className={cn("border-b transition-colors hover:bg-muted/50", className)}
      {...props}
    />
  );
}

export function TableHead({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return (
    <th
      className={cn(
        "h-10 px-2 text-left align-middle font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return <td className={cn("p-2 align-middle", className)} {...props} />;
}
`,
  // ─── composition blocks (molecules) ────────────────────────────────────────
  "app-shell": `import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export interface INavItem {
  to: string;
  label: string;
}

export interface IAppShellProps {
  title: string;
  nav: readonly INavItem[];
  children?: React.ReactNode;
}

export function AppShell({
  title,
  nav,
  children,
}: IAppShellProps): React.JSX.Element {
  const { pathname } = useLocation();

  return (
    <div className={cn("flex min-h-screen bg-background $DELTA")}>
      <aside className="w-56 shrink-0 border-r border-border bg-card p-4">
        <h1 className="mb-6 text-xl font-bold text-foreground">{title}</h1>
        <nav className="flex flex-col gap-1">
          {nav.map((item) => {
            const active =
              pathname === item.to ||
              (item.to !== "/" && pathname.startsWith(\`\${item.to}/\`));

            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 p-6">{children ?? <Outlet />}</main>
    </div>
  );
}
`,
  "page-header": `import { cn } from "@/lib/utils";

export interface IPageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  children,
}: IPageHeaderProps): React.JSX.Element {
  return (
    <div className={cn("mb-6 flex items-center justify-between gap-4 $DELTA")}>
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        {description !== undefined && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children !== undefined && (
        <div className="flex items-center gap-2">{children}</div>
      )}
    </div>
  );
}
`,
  field: `import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

export interface IFieldProps {
  label: string;
  htmlFor?: string;
  error?: string;
  children: React.ReactNode;
}

export function Field({
  label,
  htmlFor,
  error,
  children,
}: IFieldProps): React.JSX.Element {
  return (
    <div className={cn("flex flex-col gap-1.5 $DELTA")}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error !== undefined && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
`,
  "form-actions": `import { cn } from "@/lib/utils";

export function FormActions({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn("flex items-center justify-end gap-2 pt-2 $DELTA", className)}
      {...props}
    />
  );
}
`,
  toolbar: `import { cn } from "@/lib/utils";

export function Toolbar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "mb-4 flex flex-wrap items-center gap-2 $DELTA",
        className
      )}
      {...props}
    />
  );
}
`,
  "empty-state": `import { cn } from "@/lib/utils";

export interface IEmptyStateProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export function EmptyState({
  title,
  description,
  children,
}: IEmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-12 text-center $DELTA"
      )}
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description !== undefined && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      {children}
    </div>
  );
}
`,
};

/** The relative path a primitive is written to (the shadcn convention). */
export function componentPath(name: ComponentName): string {
  return `src/components/ui/${name}.tsx`;
}

/** Parse/validate a requested theme; undefined if not a known vibe. */
export function asThemeName(value: unknown): ThemeName | undefined {
  return THEME_NAMES.find((t) => t === value);
}

/** Keep only the valid, de-duplicated component names from a requested list. */
export function asComponentNames(value: unknown): ComponentName[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return COMPONENT_NAMES.filter((c) => value.includes(c));
}

/**
 * Materialize the requested primitives under a theme: a path→content map the
 * scaffolder writes. Always includes `src/index.css` (the theme's token block) plus
 * one file per component, with the theme's per-component delta baked into the
 * structure (an empty/missing delta collapses cleanly — no stray double space).
 */
export function materializeComponents(
  theme: ThemeName,
  components: readonly ComponentName[]
): Record<string, string> {
  const t = THEMES[theme];
  const out: Record<string, string> = { "src/index.css": t.tokens };

  for (const name of components) {
    const delta = t.deltas[name] ?? "";

    out[componentPath(name)] = PRIMITIVES[name]
      .replace(" $DELTA", delta.length > 0 ? ` ${delta}` : "")
      .replace("$DELTA", delta);
  }

  return out;
}
