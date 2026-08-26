# ADR Index

| ADR | Status | Title |
|---|---|---|
| 0001 | Accepted | Scope authority and Git hook interoperability |
| 0002 | Accepted; amended by 0008 | Execution environments and process isolation |
| 0003 | Accepted | Instruction trust and immutable run authorization |
| 0004 | Accepted | Dependency snapshots and graph revisions |
| 0005 | Accepted | Streaming engine adapter protocol |
| 0006 | Accepted | Minimum recovery and idempotency before pilot |
| 0007 | Accepted | Claude Code adapter and parallel DAG scheduler |
| 0008 | Accepted | Truthful trusted-local backend and explicit Codex sandbox escalation |

ADR-0001 through ADR-0006 are the accepted pre-implementation baseline for plan v1.2. Additional decisions listed in the implementation plan must still be accepted or superseded during Phase 0.

ADR-0007 documents the Phase 2 design (Claude adapter, DAG scheduler, overlap guards, integration, sync-root enforcement at dispatch time) - see [docs/PHASE-2.md](PHASE-2.md) for the implementation status.

ADR-0008 clarifies ADR-0002/0003 for the current runtime: local execution is
`trusted-local`, isolated execution remains unavailable until capability-probed, and
Codex cannot escalate from `workspace-write` without a separate recorded approval.
