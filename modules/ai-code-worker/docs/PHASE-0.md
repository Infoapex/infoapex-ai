# Phase 0 Implementation Notes

Phase 0 exists to prove that the worker can make deterministic decisions before any model writes code.

## Non-Negotiables

- No writes in the consumer checkout during `compile`.
- No operational state under the consumer repository by default.
- No raw model transcripts in durable memory.
- No direct dependency on `ai-code-control` internals.
- Unknown engine compatibility fails closed for writer mode.
- Unknown usage or cost is represented as `null`, never as `0`.
- An accepted plan authorizes read-only compilation, not writer execution.
- Repository instructions and external output cannot grant capabilities.
- A worktree is not treated as a process-security boundary.

## First Deliverables

- JSON schema loading and fixtures.
- Normalized manifest hashing.
- Run intent and immutable authorization binding contracts.
- Instruction trust policy and prompt-injection fixtures.
- Execution-environment capability contract and fake isolated backend.
- Dependency snapshot builder contract with input tree verification.
- Normalized streaming engine-event contract.
- External state-root resolver.
- Git preflight with worktree/common-dir detection.
- Sync-root policy.
- Event log append and replay.
- Fake engine.
- Quality-gate runner with timeout and redaction.
- Scope policy for repository-relative task paths.
- Pilot value-gate evaluator for `PASS`, `FAIL`, and `REVIEW_REQUIRED`.
- `doctor`, `compile`, and `status` commands.

## Exit Criteria

The same accepted plan and base commit must produce the same normalized manifest, authorization requirements, dependency snapshot metadata and validation errors on Windows and Linux, without mutating the fixture repository. No real writer starts in Phase 0.

## Current Harness

The Phase 0 harness exercises the deterministic vertical path without invoking a real AI writer:

```powershell
npm test
npm run phase0:demo
```

The demo creates a temporary Git repository with a committed accepted plan, then runs:

```text
doctor -> compile -> status
doctor -> run --engine fake -> status
```

Expected result:

- `doctor` returns `PASS`;
- `compile` writes `run-intent.json`, `manifest.json`, `authorization.json`, and `events.jsonl` under the external state root;
- `status` replays the event log and reports `AUTHORIZED`;
- `run --engine fake` creates per-task snapshots, fake engine events, agent results, evidence files, and a final `run.done` event;
- `status` for the fake run reports `DONE`;
- the fixture repository contents are not modified by `compile`;
- two identical fixture repositories produce the same generated run ID and manifest hash.

## Closure Status

Phase 0 is mechanically complete for the prototype boundary. The deterministic harness now covers:

- schema validation and manifest freeze hashing;
- authorization binding and instruction trust;
- external run state, event replay, leases, and status;
- sync-root/Git common-directory preflight;
- dependency snapshots and fake engine streaming;
- usage budgets and evidence aggregation;
- task scope path policy;
- pilot value-gate verdicts.

The next implementation boundary is Phase 1: minimum recovery around Git checkpoints and the Codex CLI adapter.
