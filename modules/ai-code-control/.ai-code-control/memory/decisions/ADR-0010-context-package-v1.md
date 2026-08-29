# ADR-0010 - AI Code Control owns context-package.v1

**Status:** Accepted
**Date:** 2026-08-28

## Context

Agent prompts currently assemble context through runtime behavior that is difficult to
compare, cache, or audit. The planner owns task intent and the worker owns execution,
so placing context compilation in either module would create an inverse dependency or
couple source selection to one execution engine.

## Decision

AI Code Control owns the engine-neutral `context-package.v1` JSON contract, structural
validation, and semantic SHA-256 digest implementation.

The digest uses a fixed canonical representation. It sorts source, omission, and
diagnostic collections and excludes `packageId`, `createdAt`, and `contextDigest`.
Instance metadata therefore does not cause false invalidation. Run/task identity,
manifest and source hashes, compiler version, rendered fragments, authority, budget,
omissions, and diagnostics remain semantic inputs.

Canonical source references must not contain local absolute paths, file URIs,
backslashes, or parent traversal. Token measurement is primary; character measurement
is allowed only as an explicit fallback. Omissions must be represented, never silently
truncated.

## Consequences

- Planner and worker can exchange the JSON artifact without depending on .NET types.
- Equivalent source collections produce the same digest regardless of discovery order.
- A compiler version or selected source change produces an explicit invalidation key.
- The contract alone does not alter prompts. Compiler integration is introduced later
  behind `off`, `observe`, and `enforce` modes.
- A breaking shape or digest rule requires a new schema version.

## Related files

- `contracts/context-package.v1.schema.json`
- `docs/CONTEXT-PACKAGE-V1.md`
- `tools/ai-code-control/src/AiCodeControl.Core/Services/ContextPackageDigest.cs`
