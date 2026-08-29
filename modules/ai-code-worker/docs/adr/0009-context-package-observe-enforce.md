# ADR 0009: Context packages roll out through off, observe and enforce modes

- Status: Accepted
- Date: 2026-08-28

## Context

Legacy provider output is advisory and assembled directly into engine prompts. Moving
immediately to compiled context would make regressions difficult to distinguish from
selection or execution failures.

## Decision

The worker consumes `context-package.v1` only through the AI Code Control CLI/JSON
boundary. Project configuration exposes three modes:

- `off`: preserve legacy provider behavior;
- `observe`: compile, validate and export packages without changing prompts;
- `enforce`: fail closed unless every task has a schema-valid, request-bound package
  whose semantic digest is independently verified.

In enforce mode, Codex and Claude prompts receive the package and no legacy provider
context. Before invocation, the event log records task ID, package ID and context
digest. Fake engines cannot run in enforce mode because they do not consume prompts.

The worker never repairs a package by mutating or redacting it after compilation,
because that would invalidate its digest. A package containing secret-looking content
is rejected. Redaction must happen in the producer before hashing.

## Consequences

- Observe mode provides a safe comparison period with byte-identical task execution.
- Enforce mode has an auditable package-to-invocation link and deterministic failures.
- Run artifacts expose source provenance without making the generated index canonical.
- Formal rule/criterion/diff/evidence source maps remain a separate ICM-05 contract.
