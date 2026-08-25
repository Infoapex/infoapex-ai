# Value Gate Results

Date: 2026-08-25

## Planning gate

Run the repository-agnostic internal gate with:

```text
npm run value-gate:internal
```

It creates one temporary generic repository with three independent fixtures, executes planner
`propose -> inspect -> compile`, and executes every compiled plan through the
worker fake engine. This validates the full contract without consuming Claude
or Codex usage. On 2026-08-25, all three generic flows passed with worker
`DONE`, task commits, gates and evidence. The live opt-in is:

```text
npm run value-gate:live
```

Use the live command only when provider usage is available. It is expected to
block if the provider is unavailable or times out; its result is evidence, not a
replacement for the deterministic contract gate.

The live gate uses three representative tasks from the target repository under
test. Their identifiers and product terminology stay outside this repository;
the Infoapex-owned gate only records the acceptance criteria and outcome.

The first real planner proposal attempt was run with the installed Claude Code
CLI. The planner adapter was corrected to use the target repository as its
working directory and to expose a configurable timeout. The retry with a
180-second timeout still ended as:
`Claude adapter timed out after 180000ms`.

No plan was marked PASS from a fake model response. The three-plan live value gate
therefore remains `BLOCKED_EXTERNAL_CLI`, not complete.

## Failover

The worker routing test passes the complete decision path with injected adapters:

1. candidate `codex` returns `FAILED` with `HTTP 429 quota exhausted`;
2. worker classifies it as an availability/quota failure;
3. worker advances to candidate `claude`;
4. candidate `claude` returns `DONE`;
5. deterministic implementation failures do not advance to a fallback candidate.

This proves the bounded failover contract. It does not prove that the installed
Claude/Codex CLIs consistently expose quota exhaustion as a distinguishable
signal. That live provider gate remains open.

The contract test is intentionally synthetic and does not consume provider
usage. A real task is useful only for validating the provider-specific signal,
not for proving the worker's routing logic.
