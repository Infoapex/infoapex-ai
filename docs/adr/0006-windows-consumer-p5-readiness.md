# ADR-0006: Windows consumer readiness for P5 provider runs

- **Status:** accepted
- **Date:** 2026-09-05
- **Scope:** benchmark isolation, root adapter, worker worktrees, Windows .NET consumers

## Context

The EuroCarScan P5 pilot exposed failures that unit tests alone could not see:
long Git refs and physical worktree paths, copied generated state, an overly
small process environment for NuGet, and harness-owned databases treated as
agent edits. A fixed 120 second provider timeout also hid whether an execution
was slow, stuck, or looping.

## Decision

1. Provider execution uses an asynchronous watchdog with independent idle,
   hard-runtime, and repeated-completed-action limits. The normal P5 default is
   180 seconds idle and 600 seconds hard runtime; it is not a fixed 120 second
   cap.
2. Windows worktree branches and directories derive short deterministic hashes
   from run/task identity. The worker enables local `core.longpaths` before
   adding a worktree.
3. Benchmark safe copies and evaluator diffs exclude harness-owned generated
   directories, including `.infoapex-ai` and `.ai-code-control`; product edits
   are still evaluated from the independent source inventory.
4. The root subprocess adapter and worker quality gates forward the minimal
   non-secret Windows toolchain environment required by .NET/NuGet.
5. Consumer reports read the immutable persisted execution metrics, so trace
   coverage and redaction leakage evidence reach the report unchanged.
6. Any material code or evaluator change requires a new frozen experiment and
   authorization. Prior failed experiments remain evidence and are never edited.

## Evidence

EuroCarScan canary R9, experiment hash
`e876c799f39a82c705e59cf89477280461628b5e3c701b18d5cf703027fb2d12`, completed
two real Codex observations. Both passed the evaluator-owned .NET gate, hidden
oracle, and scope policy. The candidate arm recorded trace coverage `1` and
telemetry leakage `0`. The report is intentionally `INCONCLUSIVE`: one canary
pair validates integration and safety, not a comparative efficacy hypothesis.

## Consequences

New Windows ASP.NET Core consumers can be onboarded with an explicit readiness
canary before provider quota is spent on a full P5 matrix. A full matrix still
needs a separately frozen, multi-task suite with baseline-fail/known-solution-
pass proof and a declared candidate hypothesis.
