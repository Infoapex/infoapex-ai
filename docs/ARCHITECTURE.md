# infoapex-ai architecture

## Ownership

`ai-code-planner` owns intent, decomposition, deterministic linting and logical
execution-profile proposals. It never writes implementation code or claims that
the worker succeeded.

`ai-code-worker` owns compile-time validation, manifest freezing, routing policy
resolution, worktrees, engine invocation, commits, gates, evidence and terminal
status. It never imports planner code.

`ai-code-review` owns read-only milestone/repository review orchestration. It invokes
planner, control and worker only through CLI/JSON contracts and never writes the target
repository. The worker remains the owner of provider invocation and review isolation.

`ai-code-control` is an optional advisory context and memory provider. Its absence
must not block a planner or worker run.

`ai-code-docs` owns documentation orchestration. It invokes planner, control,
worker and review through their CLI/JSON contracts; worker remains the only
component allowed to invoke a writing provider.

## Optional bidirectional channel

The installer creates `.infoapex-ai/config.json`. In `independent` mode, the
modules do not use the channel. In `integrated` mode, both modules use the shared
`.infoapex-ai/runs/<runId>/` directory:

```text
planner-to-worker.json   planner -> worker plan and logical routing proposal
worker-to-planner.json   worker -> planner execution status and routing evidence
```

The channel is file-based and versioned. It is not a runtime dependency and it
does not create circular calls. A worker can still be run directly with a plan,
and a planner can still generate plans without a worker.

## Routing

The planner emits a logical `executionProfile`, for example
`balanced-default-v1`. The worker resolves it from the local
`.ai-code-worker/routing-policy.json` and freezes an ordered candidate list in
the manifest. Concrete model identifiers belong to local policy, not the
portable business plan.

Fallback is bounded to that frozen list and is permitted only for classified
provider availability signals. Scope violations, policy failures and deterministic
verification failures remain hard failures.
