# ADR-0004: Independent AI coding benchmark boundary

- Status: accepted
- Date: 2026-09-03
- Roadmap: P4.5 / BENCH

## Context

Infoapex needs evidence that orchestration and future P5 changes improve outcomes,
not merely that their own tests pass. If the system under test selects tasks,
controls the oracle, or grades its own output, the result is structurally biased.

## Decision

`ai-code-benchmark` is a standalone Node.js package and the sixth bundle module. It
interacts with Codex, Claude, and Infoapex only through versioned subprocess/JSON
contracts. It never imports their internal runtime code. The benchmark owns suite
selection, randomization, isolated repositories, raw observation logs, gates,
oracles, aggregation, and the final verdict.

The standard experiment has three frozen arms:

- A (`direct`): invoke the provider CLI directly in an isolated repository.
- B (`orchestrated-no-icm`): invoke Infoapex with context provider `none` and context
  package mode `off`.
- C (`full-icm`): invoke the same public Infoapex CLI with the configured ICM context
  path enabled.

A candidate arm D may be added for one P5 hypothesis, but may not change A/B/C.
Every observation receives a fresh worktree or copy, a deterministic seed, the same
task prompt and budget, and evaluator-only oracle material after execution.

Primary quality and safety metrics come from benchmark-owned gates, diffs, and
oracles. Provider usage and latency are normalized as secondary measurements with a
completeness flag. Missing data remains `null` and can force `INCONCLUSIVE`.

State lives outside target repositories by default, under an explicit benchmark
state root. Publish, network expansion, and secret forwarding require opt-in
capabilities. Public reports contain redacted paths and environment summaries;
private raw artifacts remain outside package and Git history.

## Feasibility decision

The three arms are implementable with the current public boundaries:

- Codex and Claude expose non-interactive subprocess entry points for arm A.
- `infoapex-ai run` delegates to `ai-code-worker`, whose default context provider is
  `none`; this is arm B without an internal bypass.
- the same worker accepts the opt-in `ai-code-control` provider and context-package
  modes through `.ai-code-worker/config.json`; this is arm C.

If a requested engine or ICM provider is unavailable, preflight returns
`UNSUPPORTED`; the harness never silently substitutes another arm.

## Consequences

The boundary adds subprocess and fixture maintenance, but keeps the evaluator useful
for competing orchestrators and prevents Infoapex implementation details from
becoming the oracle. A bounded pilot is diagnostic, not an authoritative model
ranking. P5 acceptance requires a preregistered hypothesis and metric-specific
verdict, not a hidden composite score.

