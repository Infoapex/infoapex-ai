# Context Package v1

`context-package.v1` is the machine-readable boundary between context selection and
agent execution. It records exactly which canonical inputs were selected, what was
rendered, what was omitted, and the effective budget. It does not replace source
files, ADRs, executable contracts, or the code graph.

The canonical JSON Schema is
[`contracts/context-package.v1.schema.json`](../contracts/context-package.v1.schema.json).
The example package is
[`contracts/examples/context-package.v1.example.json`](../contracts/examples/context-package.v1.example.json).

## Ownership and compatibility

- `ai-code-control` owns the contract and semantic digest implementation.
- Schema version `1.0` is strict: unknown fields are rejected.
- The planner and worker consume the JSON contract; they do not depend on the .NET
  implementation.
- Additive or breaking contract changes require an explicit new schema version.

## Semantic digest

`ContextPackageDigest` writes a fixed-order canonical JSON representation with relaxed
Unicode escaping and hashes its UTF-8 bytes with SHA-256. Source, omission, and
diagnostic collections are sorted before hashing. Consequently, collection order does
not cause false invalidation, and independent JSON consumers can recompute the digest.

The digest includes:

- run and task identity;
- manifest hash and compiler version;
- source references, hashes, authority, selection reason, selected ranges, and any
  rendered fragments;
- token measurement, effective budget, explicit omissions, and diagnostics.

The digest excludes `contextDigest`, `createdAt`, and `packageId`. `packageId` identifies
a materialized package instance; it is not a semantic compiler input. A different
instance ID or creation time therefore does not invalidate an otherwise identical
task context.

`canonicalRef` must be a repository-relative reference or a stable non-file URI. The
validator rejects drive-qualified paths, rooted paths, `file:` URIs, backslashes, and
parent traversal. Local checkout locations can never leak into or perturb the digest.

## Budget behavior

Token measurement is primary. `measurement: tokenizer` prohibits character budget
fields. If a tokenizer is unavailable, `measurement: characters-fallback` requires
both character values explicitly while preserving the converted token estimate.

Budget selection is implemented by the compiler, not by this contract layer. The
contract makes silent truncation impossible to represent: every excluded candidate
must appear in `omittedSources` with a stable ID, reason, and estimate, and compiler
diagnostics remain machine-readable.

## Authority

- `canonical`: accepted executable or governance source.
- `advisory`: useful context that cannot override canonical truth.
- `proposed`: unresolved input that must not silently become an enforced rule.
- `generated`: derived material that is reproducible and replaceable.

Authority is declared in v1 and enforced by the compiler/policy integration in later
phases. Keeping declaration and enforcement separate makes the rollout observable
before it can alter agent behavior.

## Deterministic compiler

`ContextPackageCompiler` consumes a frozen worker manifest and a task ID. Candidate
sources are selected only from declared relations, in this priority order:

1. exact repository-relative `task.requiredInputs`;
2. file-backed `task.traceability.gates[].evidenceContract` declarations;
3. files and exact line ranges resolved from `task.relevantSymbols` in the code graph.

Discovery order and text line endings are normalized. Duplicate references are collapsed, full-file required
inputs supersede symbol ranges in the same file, and sources are included whole or
reported in `omittedSources`. Glob patterns, traversal, absolute paths, and unavailable
required inputs produce diagnostics instead of guessed context. Secret-looking source
content is redacted before it can enter the materialized package or its digest.

The first compiler version uses the contract's explicit character fallback because no
model tokenizer is bundled. This is reported by `CTX_CHARACTER_FALLBACK`; both the
character budget and converted token estimate remain visible.

```text
ai-code-control context-compile \
  --repo <repository> \
  --manifest <frozen-manifest.json> \
  --manifest-sha256 <sha256> \
  --task <task-id> \
  --maximum-tokens 12000
```

The command writes one strict `context-package.v1` JSON object to stdout. `--repo` is
an explicit root override and is required when the controlled project is a nested
module in a larger Git repository.
