// The TSForge benchmark catalog — a FIXED pool of production-grade app domains
// (per ChatGPT's guidance, 2026-06-08) used to drive the headless self-improvement
// loop. A fixed catalog (not generator-invented prompts) is deliberate: it kills
// the variety-noise that made the overnight apps converge to one CRUD shape, and
// every domain is chosen to force complex type relationships, async state, forms,
// permissions, nested entities and edge cases — where a 27b starts to break down.
//
// The generation spec is ChatGPT's stress-test spec RECONCILED to our boringstack
// per-feature layout (user decision 2026-06-08): the layout differs from ChatGPT's
// by-layer folders, but the SEPARATION it demands (UI / logic / validation / types)
// is satisfied per-domain instead of in global folders.

export interface IBenchmarkApp {
  readonly slug: string;
  readonly name: string;
  /** One line on what the app IS — keeps each domain genuinely distinct. */
  readonly summary: string;
  /** ≥8 entity types the model must model (the domain's data spine). */
  readonly entities: readonly string[];
  /** The concrete user flows that exercise forms / async / edge cases. */
  readonly flows: readonly string[];
}

export const BENCHMARK_CATALOG: readonly IBenchmarkApp[] = [
  {
    slug: "saas-crm",
    name: "Multi-tenant SaaS CRM",
    summary:
      "A sales CRM scoped to an organization (tenant), with accounts, contacts, deals moving through a pipeline, and per-user roles.",
    entities: [
      "Organization (tenant)",
      "User (with Role: owner | admin | rep)",
      "Account",
      "Contact",
      "Deal (with a Stage discriminated union)",
      "Activity (call | email | meeting — discriminated)",
      "Note",
      "Tag",
    ],
    flows: [
      "Dashboard: pipeline value by stage, win-rate, recent activity",
      "Accounts list (search/filter/sort/paginate) → account detail with contacts + deals",
      "Create/edit a deal (nested contact picker, conditional 'lost reason' when stage=lost)",
      "Log an activity against a contact (discriminated form: fields change by type)",
      "Optimistic stage change on the deal board with rollback on failure",
    ],
  },
  {
    slug: "udemy",
    name: "Online Course Marketplace",
    summary:
      "A Udemy-like learning marketplace: instructors publish courses made of sections and lessons; students enrol, track progress, and leave reviews.",
    entities: [
      "User (with Role: student | instructor | admin)",
      "Course",
      "Section",
      "Lesson (with Content: video | article | quiz — discriminated)",
      "Enrollment (with progress)",
      "Review (rating 1-5)",
      "Category",
      "Coupon (with Discount: percentage | fixed — discriminated)",
    ],
    flows: [
      "Catalog: browse/search courses, filter by category + rating + price, paginate",
      "Course detail: curriculum (sections → lessons), instructor bio, reviews, enrol button",
      "Instructor studio: create/edit a course, add sections, add lessons (discriminated form — fields change by content type)",
      "My learning: enrolled courses with progress bars, mark a lesson complete (optimistic) with rollback",
      "Apply a coupon at enrol (discriminated discount math); leave a review after enrolling",
    ],
  },
  {
    slug: "pm-platform",
    name: "Project Management Platform",
    summary:
      "A Linear/Jira-like issue tracker: projects contain issues with status, priority, assignees, sub-tasks and comments.",
    entities: [
      "Workspace",
      "Project",
      "Issue (Status + Priority discriminated)",
      "SubTask",
      "User",
      "Label",
      "Comment",
      "Milestone",
    ],
    flows: [
      "Dashboard: issues by status, overdue count, per-assignee load",
      "Issue list with multi-facet filters (status, priority, assignee, label) + sort + pagination",
      "Issue detail: edit inline, add sub-tasks, comment thread",
      "Create issue (conditional fields: estimate only when type=story; due-date validation)",
      "Optimistic status drag with rollback; cached project data reused across views",
    ],
  },
  {
    slug: "hospital-scheduling",
    name: "Hospital Scheduling System",
    summary:
      "Schedule patient appointments against clinicians, rooms and shifts, with conflict detection and waitlists.",
    entities: [
      "Clinician (with Specialty)",
      "Patient",
      "Appointment (Status discriminated)",
      "Room",
      "Shift",
      "Department",
      "WaitlistEntry",
      "InsurancePlan",
    ],
    flows: [
      "Dashboard: today's schedule, utilization per room, no-show rate",
      "Calendar/list of appointments, filterable by department/clinician/status",
      "Book appointment (validate against clinician shift + room conflict; conditional referral field)",
      "Reschedule with optimistic update + conflict rollback",
      "Waitlist promotion when a slot frees up",
    ],
  },
  {
    slug: "warehouse-inventory",
    name: "Warehouse Inventory Management",
    summary:
      "Track SKUs across warehouses and bins, with stock movements, purchase orders and low-stock reordering.",
    entities: [
      "Product (SKU)",
      "Warehouse",
      "Bin",
      "StockLevel",
      "StockMovement (receipt | transfer | adjustment — discriminated)",
      "PurchaseOrder (Status discriminated)",
      "Supplier",
      "Category",
    ],
    flows: [
      "Dashboard: total stock value, low-stock alerts, movements over time",
      "Product list with search/filter by category & stock status, sort, paginate",
      "Product detail: stock by warehouse/bin, movement history",
      "Create a stock movement (discriminated form; transfer requires from+to bins)",
      "Raise a purchase order (nested line items, async submit, success/error states)",
    ],
  },
  {
    slug: "airline-ops",
    name: "Airline Operations Dashboard",
    summary:
      "Monitor flights, aircraft, crew assignments and gates, with delay tracking and disruption handling.",
    entities: [
      "Flight (Status discriminated: scheduled | boarding | departed | delayed | cancelled)",
      "Aircraft",
      "Airport",
      "CrewMember (with Role)",
      "CrewAssignment",
      "Gate",
      "Route",
      "Disruption",
    ],
    flows: [
      "Ops dashboard: on-time %, delays by cause, aircraft utilization",
      "Flight board with filters (status, route, aircraft) + sort by departure + paginate",
      "Flight detail: crew roster, gate, timeline; reassign a gate optimistically",
      "Log a disruption (discriminated by cause; conditional weather/technical fields)",
      "Crew assignment form with validation (rest-hours rule) + async submit",
    ],
  },
  {
    slug: "portfolio-manager",
    name: "Investment Portfolio Manager",
    summary:
      "Manage portfolios of holdings across asset classes, with transactions, allocations and performance.",
    entities: [
      "Portfolio",
      "Holding",
      "Asset (AssetClass discriminated: equity | bond | cash | fund)",
      "Transaction (buy | sell | dividend — discriminated)",
      "Account",
      "Watchlist",
      "PriceQuote",
      "AllocationTarget",
    ],
    flows: [
      "Dashboard: total value, allocation pie, gain/loss, top movers",
      "Holdings table (search/filter by asset class, sort by value/return, paginate)",
      "Holding detail: transaction history, allocation vs target",
      "Record a transaction (discriminated form; sell validates against quantity held)",
      "Rebalance workflow: optimistic allocation edits with cached quotes",
    ],
  },
  {
    slug: "procurement",
    name: "Procurement & Vendor Platform",
    summary:
      "Manage vendors, requisitions, purchase orders and approvals through an approval chain.",
    entities: [
      "Vendor",
      "Requisition (Status discriminated)",
      "PurchaseOrder",
      "LineItem",
      "ApprovalStep",
      "Contract",
      "Budget",
      "User (with ApprovalRole)",
    ],
    flows: [
      "Dashboard: spend by category, pending approvals, budget burn",
      "Requisition list with filters (status, requester, budget) + sort + paginate",
      "Requisition detail: line items, approval chain progress",
      "Create requisition (nested line items, conditional justification when over budget)",
      "Approve/reject step with optimistic update + rollback on async failure",
    ],
  },
  {
    slug: "billing-console",
    name: "Subscription Billing Console",
    summary:
      "Manage customers, subscription plans, invoices and payments, with proration and dunning.",
    entities: [
      "Customer",
      "Plan (BillingInterval discriminated)",
      "Subscription (Status discriminated: trialing | active | past_due | canceled)",
      "Invoice (Status discriminated)",
      "InvoiceLineItem",
      "Payment (method discriminated: card | bank | credit)",
      "Coupon",
      "UsageRecord",
    ],
    flows: [
      "Dashboard: MRR, churn, overdue invoices, revenue trend",
      "Invoice list (search/filter by status & customer, sort, paginate)",
      "Customer detail: subscription, invoices, payment methods",
      "Change plan (proration preview; conditional coupon field; async submit)",
      "Record a payment (discriminated by method) with optimistic invoice status update",
    ],
  },
  {
    slug: "ecommerce-admin",
    name: "E-commerce Admin Suite",
    summary:
      "Back-office for an online store: products with variants, orders, fulfilment, customers and discounts.",
    entities: [
      "Product",
      "Variant",
      "Order (Status discriminated: pending | paid | fulfilled | refunded)",
      "OrderItem",
      "Customer",
      "Discount (type discriminated: percent | fixed | bogo)",
      "Fulfilment",
      "Category",
    ],
    flows: [
      "Dashboard: sales today, top products, orders by status, low stock",
      "Order list with filters (status, customer, date) + sort + paginate",
      "Order detail: items, fulfilment timeline, refund workflow",
      "Create/edit a product (nested variants array; conditional inventory per variant)",
      "Create a discount (discriminated form; optimistic apply with rollback)",
    ],
  },
  {
    slug: "incident-management",
    name: "Incident Management Platform",
    summary:
      "Track operational incidents, severity, services affected, on-call responders, timelines and postmortems.",
    entities: [
      "Incident (Severity + Status discriminated)",
      "Service",
      "Responder",
      "OnCallSchedule",
      "TimelineEvent (type discriminated)",
      "Postmortem",
      "AlertRule",
      "Team",
    ],
    flows: [
      "Dashboard: open incidents by severity, MTTR, services at risk",
      "Incident list with filters (severity, status, service, team) + sort + paginate",
      "Incident detail: timeline, responders, status updates",
      "Declare incident (conditional fields by severity; async submit; validation)",
      "Post a timeline update (discriminated event form) with optimistic append + rollback",
    ],
  },
];

/**
 * The generation spec — ChatGPT's production-grade stress-test, reconciled to our
 * boringstack per-feature layout. Shared verbatim across every benchmark domain so
 * results are comparable; only the DOMAIN section (built per app) changes.
 */
export const GENERATION_SPEC = `You are building a PRODUCTION-GRADE React + Vite + TypeScript application — not a demo.
The goal is a real, complete app a company would actually ship. Build the WHOLE thing; do not simplify, stub, or leave anything incomplete.

# Hard rules (the gate enforces these — code that breaks them does not pass)
FORBIDDEN: \`any\`, \`as\` casts (except \`as const\`), \`@ts-ignore\`/\`@ts-nocheck\`, non-null \`!\`, placeholder/TODO/dead code, fake or partial implementations.
REQUIRED: strict typing everywhere; interfaces are \`I\`-prefixed (\`IInvoice\`); ONE React component per .tsx file; functional components only.

# Type safety
Every entity has explicit types. Use discriminated unions, branded IDs where useful, \`readonly\` where appropriate, and EXHAUSTIVE \`switch\` statements to narrow them. Use a \`Result<T, E>\` style ONLY for genuinely fallible RUNTIME ops (e.g. a mock-async service call that can fail) — never for data you already typed.
There is NO backend, network, or uploaded data in this app: EVERY value originates from your own typed code + seed, so TypeScript has already proven its shape. The TYPE SYSTEM is the validation. NEVER write runtime parsers, entity validators, type-guard functions, or a \`*.validators.ts\` to "check" data the compiler already guarantees — type it correctly at the source and use it directly (\`x satisfies IType\` for a literal). Never use \`any\`, \`Record<string, any>\`, or \`as\` casts.

# UI surface (all of these must exist and work)
Dashboard · list view · detail view · creation workflow · editing workflow · search · filtering · sorting · pagination · modal workflow · form validation · toast notifications · loading states · error states · empty states.

# State
local state · derived state · async state · optimistic updates (with rollback on failure) · cached data · filtering/sorting/selection state.

# Forms (≥3)
Each form: validation · nested fields · conditional fields · async submission · error handling · success handling.

# Async / errors
Every async workflow handles loading, success, failure AND retry. No silent failures.

# Accessibility
Keyboard navigation, proper labels, aria attributes, focus management, accessible dialogs.

# Project structure — BORINGSTACK, per-feature (NOT by-layer)
Co-locate by domain under \`src/features/<domain>/\`:
  <domain>.types.ts        — entity types, discriminated unions, branded IDs
  <domain>.constants.ts    — \`as const\` registries / label maps (typed Record<Union, V>)
  <domain>.service.ts      — async data access (seeded/mock async with latency + failure paths)
  <domain>.hooks.ts        — ONLY genuine derived/computed state (the data hook is the SDK's useResource; do NOT write a fetch/query wrapper)
  <PascalCase>.tsx         — ONE component per file
  index.ts                 — barrel re-exporting the public surface
Shared shadcn primitives live in \`src/components/ui/\` (already scaffolded). Routes/pages are TanStack files under \`src/routes/\`.
This separates UI / business logic / data access / type definitions — colocated per domain, not in global folders.

# Domain complexity (minimum bar)
≥8 entity types · 20+ interfaces/types · multiple relationships · nested structures · enums-as-const · discriminated unions.

# Deliverables
Generate ALL files. Imports must resolve. TypeScript must compile (strict). React must render (no blank screen). Every listed user flow must be implemented and reachable in the UI. Do NOT simplify the requirements.`;

/** Compose the full build prompt for one benchmark domain. */
export function buildBenchmarkPrompt(app: IBenchmarkApp): string {
  const entities = app.entities.map((e) => `  - ${e}`).join("\n");
  const flows = app.flows.map((f) => `  - ${f}`).join("\n");

  return `${GENERATION_SPEC}

# THE APP TO BUILD: ${app.name}
${app.summary}

## Entities to model (at least these)
${entities}

## User flows to implement
${flows}

Build this specific application, in full, following every rule above.`;
}

/** Look up a benchmark app by slug or 1-based catalog index; undefined if absent. */
export function findBenchmarkApp(selector: string): IBenchmarkApp | undefined {
  const bySlug = BENCHMARK_CATALOG.find((app) => app.slug === selector);

  if (bySlug !== undefined) {
    return bySlug;
  }

  const index = Number(selector);

  if (
    Number.isInteger(index) &&
    index >= 1 &&
    index <= BENCHMARK_CATALOG.length
  ) {
    return BENCHMARK_CATALOG[index - 1];
  }

  return undefined;
}

/**
 * The JUDGE rubric (ChatGPT's grading prompt) — for the OFFLINE flagship review of
 * a built app (never a runtime dependency). Pair with rejudge.ts / a flagship judge
 * via TSFORGE_JUDGE_*; it grades the diff against the same bar the spec demands.
 */
export const JUDGE_RUBRIC = `You are grading a React + Vite + TypeScript application built by a coding system, against a production-grade bar. Be a harsh, specific senior reviewer. Score 1-5 overall and per-dimension, and list concrete defects (file + what's wrong).

Dimensions:
1. Type safety — discriminated unions, branded IDs, readonly, exhaustive switches, Result<T,E> for genuinely-fallible runtime ops; NO any/as/!/Record<string,any>. PENALIZE runtime parsers/entity-validators/type-guards/*.validators.ts that "check" already-typed seed data — there is no untrusted input, so that is dead ceremony, not type safety.
2. State management — local/derived/async/optimistic(+rollback)/cached/filter/sort/selection actually present and correct.
3. Component architecture — one component per file, clean props, no god-components, sensible composition.
4. Forms — ≥3 with validation, nested + conditional fields, async submit, error AND success handling.
5. Data modeling — ≥8 entities, 20+ types, real relationships, nested structures.
6. Error/async handling — every async path handles loading/success/failure/retry; no silent failures.
7. UI completeness — dashboard, list, detail, create, edit, search, filter, sort, paginate, modal, toasts, loading/error/empty states ALL present and reachable.
8. Accessibility — keyboard nav, labels, aria, focus management, accessible dialogs.
9. Runtime robustness — renders (no blank screen), survives interaction, no console/uncaught errors.
10. Realism — feels like a real company app, not a toy.

For each dimension: score + the single most important defect. Then an overall score and the top 3 things to fix. Penalize HARD for: missing flows, stubbed/placeholder code, type holes, blank-screen or crash-on-interaction.`;
