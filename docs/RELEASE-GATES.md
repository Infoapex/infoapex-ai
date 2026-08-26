# Release gates

The first three modules are not called production-complete merely because their
TypeScript builds pass.

Required gates:

- `ai-code-worker`: full deterministic suite, routing/fallback tests, JSON contract validation, and live verification that the installed Claude/Codex CLIs expose a stable quota or availability signal.
- `ai-code-planner`: full suite plus three representative end-to-end plans that pass linting, compile against the pinned worker contract, and execute through worker.
- `ai-code-review`: full deterministic suite plus an internal planner -> control -> worker read-only review gate.
- `ai-code-docs`: full deterministic suite plus an internal planner -> control -> worker -> review documentation gate.
- `infoapex-ai`: installer init in both modes, status, handoff write/read, bundle clean-clone bootstrap and ZIP extraction.

The reproducible local gate is `npm run value-gate:internal`. It creates three
generic target fixtures, runs planner `propose -> inspect -> compile`, and runs
each compiled plan through worker `run --engine fake`. It consumes no provider
usage. `npm run value-gate:live` is an explicit opt-in for the same flow with
the installed Claude CLI and is the only gate that consumes provider usage.

Until the live quota signal and the three-plan value gate pass, the correct
status is implemented candidate, not an unqualified production release.

Validation update 2026-08-25: the bounded mid-task fallback contract is covered
and passing (`codex` quota failure -> `claude` success; deterministic failure does
not fallback). The live three-plan proposal gate was attempted against a large
target workspace, but the installed CLI timed out after 180 seconds; it remains
blocked on external CLI execution, with evidence in
`validation/value-gate/README.md`. The internal contract gate does not require a
real quota-consuming task: provider outcomes are injected deterministically.
The repository-agnostic internal three-plan gate now passes 3/3 through planner
and worker fake execution; only the usage-consuming live variant remains open.

Codex live update 2026-08-25: `codex-cli 0.147.0` passed doctor and a disposable
real worker task completed with `DONE`, a worker-owned commit and a passing gate
in a historical, explicitly privileged `danger-full-access` pilot. The same host
blocked the `workspace-write` invocation. This result demonstrates adapter
compatibility, not OS isolation, and does not change the secure default. Current
runs use `workspace-write`; `danger-full-access` requires a separate recorded
approval and is never an automatic fallback. The remaining external validation is
Claude's usage-consuming planner/value gate and its real quota signal.

Security gate update 2026-08-26: the bundled local backend is truthfully classified
as `trusted-local`. An `isolated` writer remains blocked until an OS/container/VM or
remote backend proves every required capability. A release must not describe Git
worktrees, scope verification or the fake test backend as host isolation. A
`trusted-local` pilot requires both repository eligibility and a separate CLI/API
authorization; a repository-controlled config cannot grant it. Codex
`danger-full-access` follows the same external-approval rule, and both authorization
records are immutable across recovery.
