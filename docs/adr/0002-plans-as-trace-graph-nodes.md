# ADR-0002: Plans and task outcomes as trace graph nodes

- Status: proposed
- Date: 2026-08-30

## Context

`ai-code-control`'s own ADR-0004 (`vector-search-not-refactor-truth`) establishes four
independent truth sources, each deterministic in its own domain:

```text
memory-brief     = context (what we decided and why)
impact-analysis  = code truth (what will break)
run-validation   = functionality truth (tests/lint)
git diff         = modification truth (what changed)
```

ADR-0011 (`hybrid-code-trace-graph`) adds a fifth structure, the trace graph, precisely
to cover what none of the four could: authoritative multi-hop questions such as why a
rule exists, which evidence verified a criterion, and which decision is current. Its
routing rule is the property this proposal depends on: *"Unsupported routes fail
explicitly instead of silently returning approximate FTS matches."* Measured in
`TRACE-QUERY-EVALUATION.md`, this reaches 25/25 route/evidence accuracy with typed
failure states (`stale`, `not_found`, `unsupported`, `partial` with an exact reason) and
never a silent fallback.

`trace-ingest-manifest.v1` already declares `plan` as a valid document `kind`, alongside
`adr`, `contract`, `context-package`, `source-map`, and `relations`. No producer emits
one. Neither `ai-code-worker` nor `ai-code-planner` ever writes a plan, a task outcome,
or a routing decision into the trace graph. The formula above has no line for decision
truth over the *project's own* plans and completed tasks — only over hand-authored ADRs
and contracts.

Separately, `context-compile` (`ContextPackageCompiler`, contract `context-package.v1`,
owned by `ai-code-control` per ADR-0010) already produces a machine-readable,
SHA-256-digested record of exactly which sources were selected for a task, what was
omitted, and the effective token budget. `ai-code-planner` does not call it. Plan
authoring today is not backed by an auditable, reproducible context selection; it is
whatever the planner's own prompt assembly happens to include.

ADR-0005 mandates `memory-brief` "before any non-trivial task," but this is a documented
behavioral rule an agent must remember to follow (see `CLAUDE.md`), not a step the
pipeline enforces. There is no equivalent mandatory step tying `ai-code-planner` to
`context-compile`, or tying a completed `ai-code-worker` run back into the trace graph.

This gap is the direct cause of a real risk: as a project accumulates plans and
decisions over time, an agent revisiting it later has no deterministic way to ask "what
was decided here and is it still current" beyond re-reading source or falling back to
FTS, which ADR-0011 already measured as frequently `partial` — it locates prose, not a
typed, evidenced answer.

## Non-goals

This ADR does not claim to eliminate hallucination or to give an LLM complete recall of
the project. No mechanism can inject an unbounded project history into a bounded context
window. `context-compile` still enforces `maximumTokens`; `memory-brief` still caps
`maxRecallItems` and `maxBriefingTokens`. What this ADR can deliver is narrower and
verifiable: when the declared graph does not have an answer, the system fails explicitly
(`not_found`/`stale`/`unsupported`/`partial`-with-reason) instead of guessing, and every
context selection becomes an auditable artifact instead of an untracked prompt. That is
the same property ADR-0011 already delivers for hand-authored ADRs and contracts,
extended to cover plans and task outcomes.

Per ADR-0011, rule 9, this proposal introduces no new graph technology, no embeddings,
no vector database. It is additional producers and consumers of the existing
`trace_nodes`/`trace_edges` schema and the existing `context-package.v1` contract.

## Decision

Extend the ADR-0004 formula with a fifth, already-partially-built line:

```text
memory-brief     = context (what we decided and why)
impact-analysis  = code truth (what will break)
run-validation   = functionality truth (tests/lint)
git diff         = modification truth (what changed)
trace (why/current/evidence-for) = decision truth (what was decided, on what evidence,
                                    still current or superseded)
```

Close the gap in three producer/consumer changes, each owned by the module that already
owns the relevant behavior:

1. **`ai-code-worker`, at task `PASS`.** In addition to the existing human-authored task
   summary flow, emit a `trace-ingest-manifest.v1` entry of kind `plan` referencing the
   compiled plan the task executed, and run `trace-ingest` against it. Declare, at
   minimum, the edges `task verified_by gate` (from the run's gate results) and
   `task implements plan` (from the frozen manifest). Where a plan explicitly supersedes
   an earlier one for the same scope, declare `plan supersedes prior-plan`. These are T0
   deterministic edges per ADR-0011's trust tiers: derived mechanically from the run
   report and manifest, not inferred.

2. **`ai-code-planner`, before compiling a new plan.** Call `context-compile` against the
   accumulated trace graph, code graph, and memory FTS for the task at hand, and treat
   the resulting `context-package.v1` as the planner's actual input instead of an
   unaudited prompt assembly. This makes ADR-0005's intent — context before action —
   mandatory and machine-enforced for the planning stage specifically, rather than a rule
   an agent must remember.

3. **A `graph-drift` gate before the next planning cycle.** Run it non-interactively
   against repository HEAD before `ai-code-planner` starts a new task. `FAIL` or
   (optionally, via `--fail-on-review`) `REVIEW_REQUIRED` blocks the cycle instead of
   letting planning proceed against a trace graph that has silently fallen behind.

## Consequences

- `ai-code-worker` gains a new responsibility: writing to the trace graph, not only to
  Git and its own run report. This is a real scope increase for a module this bundle's
  own `docs/ARCHITECTURE.md` currently describes as owning "compile-time validation,
  manifest freezing, routing policy resolution, worktrees, engine invocation, commits,
  gates, evidence and terminal status" — trace-graph ingestion is not yet in that list
  and should be added to it if this ADR is accepted.
- `trace-ingest` runs on every `PASS`, not only on demand. Latency and failure-mode cost
  (what happens to a task's terminal status if ingestion itself fails) need measurement
  before this is unconditional; a reasonable default is to make ingestion failure a
  warning attached to the run report, not a reason to flip a `PASS` to `BLOCKED`, since
  `docs/ARCHITECTURE.md` already declares `ai-code-control` advisory: "Its absence must
  not block a planner or worker run."
- `ai-code-planner` gains a dependency on `ai-code-control` being present and healthy to
  get the full benefit of item 2; per the project's existing independence rule, its
  absence must degrade context richness, not block plan compilation.
- This spans three standalone repositories (`ai-code-control`, `ai-code-worker`,
  `ai-code-planner`), plus this bundle's projection once each is pinned. Per ADR-0001,
  implementation lands in the standalone modules first, is verified there, and is
  projected into `modules/provenance.json` second — not implemented directly in the
  bundle.
- None of this changes `maxRecallItems`, `maxBriefingTokens`, or `context-compile`'s
  `maximumTokens`. A project with enough history will still not fit in one context
  window; what changes is that the boundary of what fit is recorded, not silent.

## Open questions for implementation planning

- Exact edge vocabulary for `task implements plan` / `plan supersedes prior-plan`: does
  this need new relationship types in the trace graph, or do existing ones cover it?
- Where does a plan's `canonicalRef` point when `--out` is a free-form path chosen per
  invocation (see Quick Start in the bundle README)? A fixed convention may be needed
  before ingestion can be automated reliably.
- Should `graph-drift` failure be `--fail-on-review` (strict) or `FAIL`-only (lenient) by
  default in the planning gate, given `ai-code-control` is advisory elsewhere?
