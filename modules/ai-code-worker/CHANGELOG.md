# Changelog

## Unreleased

- Amend the implementation plan to v1.2 with explicit process isolation, instruction trust, immutable run authorization, dependency snapshots, streaming engine events, and minimum recovery before pilot.
- Accept ADR-0001 and add ADR-0002 through ADR-0006.
- Add public schemas for execution environments, run authorization, task input snapshots, and normalized engine events.
- Make `contextProvider: "none"` and isolated execution the consumer-template defaults.
- Split the three-task technical pilot from the expanded eight-to-ten-task value gate.
- Implement the deterministic Phase 0 runtime path: schema validation, external state roots, Git preflight, compile/status, event replay, fake engine/gates, and a fixture demo.
- Implement the Phase 1 single-engine/single-writer MVP path: task worktrees, worker-owned commits, real quality gates, recovery checkpoints, Codex CLI adapter/run path, read-only review coverage, and terminal reports.
- Close the five post-dogfooding robustness items before Phase 3: behavioral adapter smoke checks, async Codex/Claude adapter execution, worktree runtime-directory links for real build/test gates, a local isolated execution backend, and CLI/project-config adapter tuning.
- Discover Claude/Codex executables from PATH and known local editor installations, with behavioral smoke tests as the default compatibility gate and explicit version ranges retained as an opt-in override.
- Inject bounded per-task `ai-code-control` briefs and explicitly declared symbol impact into real-engine prompts as advisory context.
- Confirm the bundled worker source as the bootstrap/pilot distribution channel; defer any separately packaged installer artifact to the bundle release process.

## 0.0.0 - 2026-08-01

- Bootstrap independent `ai-code-worker` repository.
- Add v1.1 implementation plan and ADR-0001.
- Add initial JSON schemas, project templates, report examples, and JSON validation.
