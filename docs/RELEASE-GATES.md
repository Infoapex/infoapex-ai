# Release gates

The first three modules are not called production-complete merely because their
TypeScript builds pass.

Required gates:

- `ai-code-worker`: full deterministic suite, routing/fallback tests, JSON contract validation, and live verification that the installed Claude/Codex CLIs expose a stable quota or availability signal.
- `ai-code-planner`: full suite plus three representative end-to-end plans that pass linting, compile against the pinned worker contract, and execute through worker.
- `ai-code-review`: full deterministic suite plus an internal planner -> control -> worker read-only review gate.
- `ai-code-docs`: full deterministic suite plus an internal planner -> control -> worker -> review documentation gate.
- `infoapex-ai`: installer init in both modes, status, handoff write/read, bundle clean-clone bootstrap and ZIP extraction.

The reproducible ICM gate is `npm run value-gate:internal`. It executes 20 generic
planner `propose -> inspect -> compile` tasks through worker `run --engine fake`.
`npm run pilot:icm-graph:internal` composes that matrix with a generic consumer trace
graph, 25 hybrid queries, expected graph, coverage, drift, and Obsidian projection.
Both consume no provider usage. `npm run value-gate:live` is an explicit opt-in with
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
when invoked with explicit `--codex-sandbox danger-full-access`. The default
`workspace-write` invocation was blocked by the local CLI approval policy. The
remaining external validation is Claude's usage-consuming planner/value gate and
its real quota signal.

P2-A update 2026-08-30: the bounded two-invocation preflight passed live for Codex
and Claude. Claude usage is complete and economically comparable. Codex completed
functionally, while USD cost remains unavailable; token counts require the
sanitized local-rollout fallback because CLI 0.147.0 omits them from `exec --json`
stdout. The combined economic verdict is therefore `inconclusive`. P2-B and the
three-arm comparison remain release gates; `GRAPH-06` is still disabled.
