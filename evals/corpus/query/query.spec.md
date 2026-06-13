---
id: query
title: In-memory SQL query engine
verify: bun test
mode: scratch
---

## Acceptance criteria

A1. `Lexer` tokenizes a query string into typed tokens: keywords (SELECT, FROM, WHERE, ORDER, BY, AND, OR, ASC, DESC, LIMIT), identifiers, number literals, string literals (single quotes), operators (=, !=, <, >, <=, >=), delimiters (parentheses, comma, star).

A2. `Parser` builds an AST from tokens: `SELECT <cols|*> FROM <table> WHERE <expr> ORDER BY <col> [ASC|DESC] LIMIT <n>` with WHERE/ORDER/LIMIT optional. Expr grammar: comparison terms (col OP value) combined with AND/OR, parenthesized groups, correct precedence (AND binds tighter than OR), recursive descent. Throws typed error on malformed input.

A3. `Executor` runs the AST over `rows: ReadonlyArray<Record<string, string | number | null>>`: comparison semantics (null compares unequal to everything including itself for =; != null is true; ordering puts nulls last; cross-type comparisons follow stable rules), ORDER BY is stable sort, LIMIT truncates, column projection (\* = all keys; explicit cols project subset).

A4. Query pipeline: lexer → parser → executor → projected rows. Integrates all three stages cleanly.

## Tasks

1. [lexer] Implement tokenizer
   accept: bun test query.test.ts
   files: lexer.ts
   context: query.test.ts

2. [parser] Implement recursive descent parser with AND/OR precedence
   accept: bun test query.test.ts
   files: parser.ts
   context: query.test.ts

3. [executor] Implement executor with null semantics and stable sort
   accept: bun test query.test.ts
   files: executor.ts
   context: query.test.ts

4. [query] Wire lexer, parser, executor into query pipeline
   accept: bun test query.test.ts
   files: query.ts
   context: query.test.ts
