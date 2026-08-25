# ADR-0003 — Fallback ownership: planner proposes, worker verifies, freezes, and executes

- **Status:** `accepted` — 2026-08-16
- **Date:** 2026-08-16
- **Relates to:** ADR-0001 (`executionProfile` schema extension), ADR-0002 (plan and manifest ownership)

## Context

ADR-0001 introduces `executionProfile` as an optional, backward-compatible field on the manifest task object. The field carries a logical profile name resolved by worker at compile time into a frozen snapshot that includes `engine`, `resolvedModel`, `fallbacks`, `reason`, `confidence`, and `policyVersion`.

The word *fallbacks* in that snapshot opens a question: **who owns the fallback decision, and when is a fallback permitted?**

Two related but distinct mechanisms exist today:

1. **`ai-code-worker --fallback-engine`** (built 2026-08-16, `cli.ts`): a pre-run, whole-run failover chosen by the human invoking worker directly. If the primary engine fails `doctor` before the run starts, the entire run is retried on the fallback engine. Scope is whole-run; owner is the human operator.

2. **`executionProfile.fallbacks`** (proposed by planner, frozen by worker): a per-task ordered list of candidate engine/model pairs that worker may transition through at runtime if the active candidate becomes unavailable. Scope is per-task; owner is the planner (proposal) and worker (verification and execution).

Without an explicit decision, these two mechanisms could be conflated or the per-task fallback could be misapplied to situations that require a harder failure signal.

## Decision

**The per-task fallback lifecycle is as follows:**

1. **Planner proposes.** The planner populates `executionProfile` with a logical profile that includes an ordered `fallbacks` list of candidate engine/model pairs. Concrete model identifiers do not appear in the plan; only profile names do.

2. **Worker verifies at compile time.** When worker compiles the plan into a frozen manifest, it calls `doctor()` for each candidate in the fallbacks list. Candidates that fail availability are removed. The resulting ordered list — only confirmed-available candidates — is recorded in the frozen snapshot. If no candidates remain after pruning, compilation fails.

3. **Worker freezes the resolved snapshot.** The frozen manifest records the verified, pruned `fallbacks` list alongside the primary `engine`, `resolvedModel`, `confidence`, `reason`, and `policyVersion`. After freezing, the list is immutable for that run.

4. **Worker executes the transitions at runtime.** If the active engine/model becomes unavailable mid-task (e.g., a transient API outage), worker advances to the next entry in the frozen fallbacks list. Each transition is logged. If the list is exhausted, the task fails with status `FAILED`.

**Fallback is never permitted in response to:**

- A `POLICY_FAILURE` — any output that fails a policy gate. A policy failure indicates the model produced out-of-scope content, not that the model is unavailable. A model swap does not fix a policy violation; it conceals it. The task must produce `BLOCKED` and halt.
- A scope violation — any write or read outside `allowedPaths`, or any touch of a `forbiddenPaths` entry. Scope violations are deterministic and intentional by the model, not a transient infrastructure fault. They must produce `BLOCKED`.
- A failed deterministic test or verify command — any `verify` script or gate that exits non-zero. Deterministic failures are reproducible; a different model does not change the outcome. These outcomes must either produce `BLOCKED` or enter the existing bounded repair cycle (retry with the same engine, up to the configured attempt limit), never a silent model swap.

The rule: **fallback is an availability signal, not a quality escape hatch.**

**Relationship to `--fallback-engine`.** Both mechanisms share the same underlying `doctor()` availability signal. They differ in scope and owner:

| | `--fallback-engine` | `executionProfile.fallbacks` |
|---|---|---|
| Scope | Whole run | Per task |
| Trigger | `doctor()` fails before the run starts | Engine/model becomes unavailable mid-task |
| Owner | Human operator (CLI flag) | Planner (proposal) + Worker (verification, execution) |
| When decided | Pre-run | Compile time (verification) + runtime (execution) |

The two mechanisms are additive and non-conflicting. A run may use both: `--fallback-engine` guards the run start; `executionProfile.fallbacks` guards individual tasks during execution.

## Consequences

**What this ADR does and does not change.** This ADR does not modify `ai-code-worker`'s contract, schema, or runtime by itself. It constrains how planner will populate the `executionProfile.fallbacks` field once ADR-0001's schema extension is implemented. Worker behaviour follows from the schema definition; this ADR records the invariants that schema and implementation must enforce.

**Hard failures stay hard.** By excluding policy failures, scope violations, and deterministic test failures from the fallback trigger set, worker preserves its integrity guarantees. A plan that violates scope does not become acceptable by running on a different model.

**Observability.** Every transition through the fallbacks list must be logged at the task level. The frozen manifest already records the verified candidates; the run report must record which candidate executed and whether any transitions occurred.

**Compile-time safety.** Pruning unavailable candidates at compile time means runtime has a bounded, pre-verified list. It cannot attempt an engine that was already known to be down when the manifest was frozen. This eliminates a class of runtime surprise.

**Planner confidence.** If the verified fallbacks list is shorter than proposed (candidates pruned by `doctor()`), worker should surface this as a warning on the plan review before execution, not silently. The planner's confidence score should account for reduced fallback coverage.

## Alternatives rejected

**Worker decides fallbacks autonomously at runtime.** Worker would pick any available engine on failure, without a planner-proposed list. Rejected: this makes routing non-reproducible and untestable. The same task could execute on different engine/model pairs in different runs with no plan-level record of the intent.

**Fallback permitted on policy failure.** The argument was that a capable model might pass a gate a cheaper model failed. Rejected: the gate is checking the *output* against a policy, not the model's *availability*. Using a different model to pass a policy gate is indistinguishable from policy laundering and would make gates unenforceable.

**Fallback permitted on scope violation.** Same argument pattern, same rejection: scope is determined by `allowedPaths` and `forbiddenPaths`, which are fixed for the task. A different model faces the same scope constraints.

**Fallback permitted on deterministic test failure.** A deterministic test exits non-zero because the artefact is wrong, not because the model was unavailable. Running a different model does not change the artefact already produced. The correct response is the bounded repair cycle (retry with a corrective prompt on the same engine) or `BLOCKED`.
