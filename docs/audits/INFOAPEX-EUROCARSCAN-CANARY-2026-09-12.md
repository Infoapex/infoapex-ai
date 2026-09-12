# EuroCarScan live canary — 2026-09-12

This is a redacted integration record for the bounded canary run
`eurocarscan-live-canary-20260912-r1`. It is not a product-value or GA verdict.

## Result

- repository: `C:\__infoapex\eurocarscan`
- base commit: `50977c32c5f785744473cb494bccefdbf372e9df`
- engine: Codex `0.153.4`, explicit `danger-full-access` sandbox
- context provider: `ai-code-control` 1.2.0, health/brief/refresh `OK`
- tasks: `CANARY-01`, `CANARY-02`
- task status: `DONE`, `DONE`
- gate status: all 3 bounded verification gates `PASS`
- findings: none
- execution environment: isolated, external state root, sequential writer

The two tasks only read canonical C# and TypeScript sources and produced evaluator
evidence in worker worktrees. No production source, consumer main branch, deployment,
push, network-write, secret, or raw provider output was included in this repository.

## Interpretation

This run confirms that the repaired root-to-worker transport can execute a fresh
consumer canary with control-plane context and bounded scope. It does not satisfy the
P6 consumer adoption pilot: that protocol still requires three independent consumer
repositories, two independent users/teams, 60 real bounded tasks, a 30-day window,
upgrade/rollback, incident drill, restore evidence, and owner review.

The detailed private run evidence remains under the worker state root identified by
the run report. This repository stores only the redacted summary above.
