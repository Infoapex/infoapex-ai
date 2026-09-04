# Phase 1 Implementation Notes

Phase 1 turns the deterministic Phase 0 harness into a single-engine, single-writer MVP.

## Implemented Milestone 1

The first Phase 1 milestone establishes the Git control plane required before any real AI writer can be enabled:

- task worktree creation under the external state root;
- worker-owned branch naming per run, task, and attempt;
- real Git changed-path discovery from porcelain status;
- task scope verification against `allowedPaths` and `forbiddenPaths`;
- blocking when an agent moves `HEAD` before the worker commit;
- worker-owned commits with audit trailers for run, task, manifest, and parent commit;
- proof that the consumer checkout remains unchanged while task commits happen in the task worktree.

## Implemented Milestone 2

The fake runner now exercises that Git control plane instead of returning synthetic task commits:

- `run --engine fake` creates one external task worktree per task;
- dependency commits are materialized into dependent worktrees with Git cherry-pick before task execution;
- deterministic fake output is written only inside the task `allowedPaths`;
- task commits are produced by the worker through the same scope and `HEAD` checks used by real writers;
- run events now record `task.worktree-created` and `task.committed`;
- task evidence includes the worker-owned commit metadata.

## Implemented Milestone 3

The runner now executes real quality gates without a shell:

- `.ai-code-worker/quality-gates.json` has a JSON Schema and validated template;
- configured gate IDs resolve to `executable + args`, working directory, timeout, and env allowlist;
- explicit inline command strings are supported for simple prototype plans, while shell metacharacters are rejected;
- task `verify` gates run inside the task worktree after the worker-owned commit;
- `globalGates` run after all task commits are materialized;
- `gate.started` and `gate.finished` events are persisted;
- gate command evidence is included in task and run evidence;
- deterministic and infrastructure gate failures block the run.

## Implemented Milestone 4

Minimum recovery now covers the local single-writer checkpoints:

- `compile` is idempotent for an existing run with the same frozen manifest and authorization;
- conflicting frozen run state blocks instead of appending ambiguous events;
- completed fake runs return `DONE` idempotently without mutating the event log;
- task checkpoints are reconstructed from `task.worktree-created`, `task.committed`, and `task.finished`;
- a crash after `task.committed` can resume on the recorded commit, rerun gates on that commit, and append `task.finished`;
- recovery blocks with `RECOVERY_AMBIGUOUS` if a recorded task worktree no longer points at the recorded commit.

## Implemented Milestone 5

The Codex CLI adapter contract is now in place:

- `codex --version` is parsed and checked against tested version ranges;
- writer mode fails closed when the Codex CLI version is unavailable or untested;
- capability smoke test verifies `codex exec --help` exposes required non-interactive flags;
- exec invocations use `codex exec --json --cd <worktree> --sandbox <mode> --model <model> -c model_reasoning_effort=<effort> -`; structured results are parsed from the final JSONL `agent_message`;
- current automation does not pass `--ignore-user-config`/`--ignore-rules`: Codex CLI 0.147.0 mapped that reset to a managed read-only profile on Windows. The 2026-09-04 live pilot verified CLI 0.153.0 with `workspace-write`; this host uses the documented `windows.sandbox=\"unelevated\"` fallback because its elevated sandbox setup cannot launch child commands;
- adapter output is normalized to the shared engine event and `AgentExecutionResult` contracts;
- contract tests use a fake Codex CLI so CI does not call a model.

## Implemented Milestone 5b

The Codex CLI adapter is now wired into the single-writer `run` path:

- `run --engine codex` compiles the plan, checks the Codex adapter, and executes tasks in external task worktrees;
- Codex receives a structured JSON task prompt with run id, task id, scope, dependencies, criteria, and verification commands;
- the worker validates the returned `AgentExecutionResult` identity before committing;
- Codex-authored worktree changes are committed through the worker-owned Git commit path with the same scope and `HEAD` protections as fake runs;
- task gates, global gates, read-only review, usage policy, terminal reports, and event replay are exercised for the Codex path;
- tests use a fake Codex CLI that writes to the task worktree and returns structured output, avoiding live model calls in CI.

## Implemented Milestone 6

Read-only review and criterion coverage are now enforced:

- deterministic reviewer builds the criterion -> test -> command -> evidence matrix;
- every task acceptance criterion must map to a verification command and evidence artifact;
- `review.json` is validated against `schemas/review.schema.json`;
- `review.finished` is persisted before terminal run state;
- `DONE` is blocked with `REVIEW_FAILED` when criterion coverage is missing.

## Implemented Milestone 7

Terminal run reports are now emitted from the run artifacts:

- every `DONE` fake run writes `run-report.json` and `run-report.md`;
- budget, gate, and review blockers write final `BLOCKED` reports;
- reports include run id, plan, base commit, engine, terminal status, blocked reason, task commits, gate evidence, review status, artifact paths, and usage totals;
- task commits in the report come from worker-owned Git commits, not synthetic placeholders;
- report generation is covered by the deterministic fake-run tests.

## Remaining Phase 1 Milestones

- none for the current Phase 1 MVP scope.

## Validation

Current validation commands:

```powershell
npm test
npm run phase0:demo
```
