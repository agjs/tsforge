---
id: json-patch
title: RFC 6902 JSON Patch
verify: bun test
mode: scratch
---

## Acceptance criteria

A1. `applyPatch(doc, ops)` applies an RFC 6902 operation list to a JSON value
and returns the NEW document. The input is never mutated. Operations apply in
order; if any fails the whole patch fails and nothing is applied.

A2. Supports all six operations: `add`, `remove`, `replace`, `move`, `copy`,
`test`. `add` to an array index inserts (shifting the rest); `add` with the `-`
index appends; `add` to an object key creates or overwrites. `remove` on an
array index shifts the rest down.

A3. Pointer syntax follows RFC 6901: `""` is the whole document, path segments
are `/`-separated, and `~1` decodes to `/` while `~0` decodes to `~` — in that
order, so `~01` decodes to `~1` and not to `/`.

A4. `test` compares by DEEP structural equality, where object key order is
irrelevant but array order matters. A failing `test` rejects the patch.

A5. Errors are thrown as `PatchError` (exported) with a `path` property naming
the pointer that failed. A path into a missing parent, an out-of-range array
index, and `remove` of a non-existent key all fail. `move` into a location
inside itself (e.g. `/a` → `/a/b`) fails rather than corrupting the document.

## Tasks

1. [patch] Implement pointer resolution and the six operations
   accept: bun test patch.test.ts
   files: pointer.ts, patch.ts
   context: patch.test.ts
