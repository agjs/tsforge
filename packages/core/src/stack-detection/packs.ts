import type { IRulePackDescriptor } from "./stack-detection.types";

/**
 * Registry of all available rule packs. This is the source of truth for which packs
 * exist and under what conditions they are enabled during stack detection.
 */
export const PACK_REGISTRY = {
  "generic-ts": {
    id: "generic-ts",
    label: "TypeScript Fundamentals",
    description:
      "Core TypeScript safety rules for all projects (strict mode, index safety, no casts)",
    category: "language",
    appliesWhen: { always: true },
    guidance: "Enforce strict TypeScript rules on all projects.",
  } as const satisfies IRulePackDescriptor,

  react: {
    id: "react",
    label: "React",
    description: "React component patterns and hooks usage",
    category: "framework",
    appliesWhen: { allDeps: ["react", "react-dom"] },
    guidance: "Follow React best practices for component composition.",
  } as const satisfies IRulePackDescriptor,

  "react-component-architecture": {
    id: "react-component-architecture",
    label: "React Component Architecture",
    description:
      "Component structure, composition, and file organization for React",
    category: "framework",
    appliesWhen: { allDeps: ["react"] },
    guidance: "Organize React components with clear separation of concerns.",
  } as const satisfies IRulePackDescriptor,

  "tanstack-query": {
    id: "tanstack-query",
    label: "TanStack Query",
    description: "Patterns for data fetching with TanStack Query",
    category: "library",
    appliesWhen: { anyDeps: ["@tanstack/react-query"] },
    guidance: "Use TanStack Query for async state management.",
  } as const satisfies IRulePackDescriptor,

  drizzle: {
    id: "drizzle",
    label: "Drizzle ORM",
    description: "Database access patterns using Drizzle ORM",
    category: "library",
    appliesWhen: { anyDeps: ["drizzle-orm"] },
    guidance: "Use Drizzle ORM type-safely for database queries.",
  } as const satisfies IRulePackDescriptor,

  elysia: {
    id: "elysia",
    label: "Elysia",
    description: "HTTP server patterns with Elysia framework",
    category: "framework",
    appliesWhen: { anyDeps: ["elysia"] },
    guidance: "Follow Elysia patterns for HTTP routing and middleware.",
  } as const satisfies IRulePackDescriptor,

  fastify: {
    id: "fastify",
    label: "Fastify",
    description:
      "Schema-first Fastify routing, plugin encapsulation, and test hygiene",
    category: "framework",
    appliesWhen: { anyDeps: ["fastify"] },
    guidance:
      "Use schema-driven routes, fastify-plugin for shared decorators, and fastify.inject with app.close() in tests.",
  } as const satisfies IRulePackDescriptor,

  nextjs: {
    id: "nextjs",
    label: "Next.js",
    description:
      "App-router correctness: server/client boundaries and dead pages-router APIs",
    category: "framework",
    appliesWhen: { anyDeps: ["next"] },
    guidance:
      "Follow Next.js app-router conventions: mark interactive files 'use client' and use the Metadata API and Server Components instead of pages-router APIs.",
  } as const satisfies IRulePackDescriptor,

  bullmq: {
    id: "bullmq",
    label: "BullMQ",
    description: "Job queue patterns with BullMQ",
    category: "library",
    appliesWhen: { anyDeps: ["bullmq"] },
    guidance: "Use BullMQ for reliable async job processing.",
  } as const satisfies IRulePackDescriptor,

  "test-conventions": {
    id: "test-conventions",
    label: "Test Conventions",
    description:
      "Testing patterns and file structure for vitest, jest, or Bun tests",
    category: "testing",
    appliesWhen: {
      anyDeps: ["vitest", "jest", "bun-types"],
      files: ["vitest.config.*", "jest.config.*"],
    },
    guidance: "Follow consistent test organization and naming.",
  } as const satisfies IRulePackDescriptor,

  "env-access": {
    id: "env-access",
    label: "Environment Variables",
    description:
      "Safe environment variable access patterns (validation and typing)",
    category: "infra",
    appliesWhen: { always: true },
    guidance: "Always validate and type environment variables.",
  } as const satisfies IRulePackDescriptor,

  "module-boundaries": {
    id: "module-boundaries",
    label: "Module Boundaries",
    description: "Enforce clear module boundaries and layering",
    category: "infra",
    appliesWhen: { always: true },
    guidance:
      "Maintain clean module boundaries to avoid circular dependencies.",
  } as const satisfies IRulePackDescriptor,

  "code-flow": {
    id: "code-flow",
    label: "Code Flow",
    description: "Control flow clarity and early returns",
    category: "language",
    appliesWhen: { always: true },
    guidance: "Keep control flow clear and readable with early returns.",
  } as const satisfies IRulePackDescriptor,

  "comment-hygiene": {
    id: "comment-hygiene",
    label: "Comment Hygiene",
    description: "Meaningful comments and documentation standards",
    category: "language",
    appliesWhen: { always: true },
    guidance: "Write comments that explain intent, not what the code does.",
  } as const satisfies IRulePackDescriptor,

  security: {
    id: "security",
    label: "Security",
    description:
      "Application security guardrails: command injection, ReDoS, DOM XSS, and silent error masking",
    category: "infra",
    appliesWhen: { always: true },
    guidance:
      "Avoid shell execution, dynamic regex, innerHTML assignment, and catch blocks that silently mask failures.",
  } as const satisfies IRulePackDescriptor,

  "runtime-boundaries": {
    id: "runtime-boundaries",
    label: "Runtime Boundaries",
    description:
      "Runtime boundary safety: open redirects, SSRF, prototype pollution, webhook verification, and upload limits",
    category: "infra",
    appliesWhen: { always: true },
    guidance:
      "Use literal redirect/fetch URLs, avoid merging request fields into objects, verify webhooks before parsing, and cap multipart uploads.",
  } as const satisfies IRulePackDescriptor,

  "typescript-core": {
    id: "typescript-core",
    label: "TypeScript Core",
    description:
      "Cross-cutting TypeScript boundary safety: fetch status checks, JSON validation, and export typing",
    category: "language",
    appliesWhen: { always: false },
    guidance:
      "Validate HTTP responses, parse JSON through schemas, and annotate exported function return types.",
  } as const satisfies IRulePackDescriptor,

  authorization: {
    id: "authorization",
    label: "Authorization",
    description:
      "Experimental authorization heuristics for routes, server actions, and object-level access",
    category: "infra",
    appliesWhen: { always: false },
    guidance:
      "Mutating handlers should call authorization helpers before writes; opt in via the security profile.",
  } as const satisfies IRulePackDescriptor,

  "structured-logging": {
    id: "structured-logging",
    label: "Structured Logging",
    description: "Logging patterns using Pino, Winston, or structured loggers",
    category: "infra",
    appliesWhen: { anyDeps: ["pino", "winston"] },
    guidance: "Use structured logging with consistent JSON output.",
  } as const satisfies IRulePackDescriptor,

  "jwt-cookies": {
    id: "jwt-cookies",
    label: "JWT & Cookies",
    description: "Secure JWT and cookie handling patterns",
    category: "library",
    appliesWhen: { anyDeps: ["jsonwebtoken", "jose"] },
    guidance: "Implement JWT and cookies securely.",
  } as const satisfies IRulePackDescriptor,

  "oauth-security": {
    id: "oauth-security",
    label: "OAuth Security",
    description: "OAuth and OpenID patterns and security considerations",
    category: "library",
    appliesWhen: { anyDeps: ["arctic", "openid-client", "passport"] },
    guidance: "Follow OAuth/OpenID best practices.",
  } as const satisfies IRulePackDescriptor,

  "i18n-keys": {
    id: "i18n-keys",
    label: "i18n Keys",
    description: "Internationalization key management and translation patterns",
    category: "library",
    appliesWhen: { anyDeps: ["i18next", "react-i18next"] },
    guidance: "Keep i18n keys organized and validated.",
  } as const satisfies IRulePackDescriptor,

  "ai-sdk": {
    id: "ai-sdk",
    label: "AI SDK Security",
    description:
      "LLM/AI-SDK security and cost guardrails: no provider key in client bundles, bounded completion tokens, no request data in the system prompt",
    category: "library",
    appliesWhen: {
      anyDeps: [
        "ai",
        "openai",
        "@anthropic-ai/sdk",
        "@ai-sdk/openai",
        "@ai-sdk/anthropic",
      ],
    },
    guidance:
      "Call models server-side, bound output tokens, and keep the system prompt constant.",
  } as const satisfies IRulePackDescriptor,
} as const;

/** Ordered list of always-on pack IDs (for deterministic ordering). */
export const ALWAYS_ON_PACKS = [
  "generic-ts",
  "env-access",
  "module-boundaries",
  "code-flow",
  "comment-hygiene",
  "security",
  "runtime-boundaries",
] as const;

/** Type-safe record of all pack descriptors. */
export type IPackRegistry = typeof PACK_REGISTRY;

/** Type-safe pack ID type. */
export type IPackId = keyof IPackRegistry;
