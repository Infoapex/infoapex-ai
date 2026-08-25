# Provider signal validation

The worker's quota/provider classifier is already covered by deterministic
tests. A live validation must prove that the installed CLI emits a message that
is distinguishable from a deterministic implementation failure.

## Controlled live procedure

Run this only when the provider account has enough usage for a bounded run:

```text
$env:APEX_VALUE_GATE_TIMEOUT_MS = "60000"
npm run value-gate:live
```

The live gate:

1. creates a disposable generic repository;
2. asks the installed Claude CLI for three plans;
3. inspects and compiles each plan;
4. executes each compiled plan through the real Claude worker path;
5. reports the worker's terminal status and bounded failure evidence.

Use `APEX_CLAUDE_EXECUTABLE` or `APEX_CLAUDE_MODEL` only when the default CLI
discovery or model is not the desired one. The temporary repository and reports
are removed after the command; no raw transcript is persisted by Apex.

For a CLI session that requires explicit edit approval in a non-interactive run,
the disposable live gate can receive the worker permission mode through+`APEX_CLAUDE_PERMISSION_MODE=acceptEdits`. This affects only the temporary value+gate invocation, not the worker's project configuration.

## Interpretation

- `PASS`: all three proposals, inspections, compilations and worker executions
  completed successfully. This proves the live value gate for that CLI/session.
- `BLOCKED` with a quota/rate-limit/provider message: the provider signal is
  observable and the worker can classify it for bounded fallback.
- `BLOCKED` with a timeout or generic engine error: provider classification is
  still unproven. Do not convert that result into a quota failure.

The internal counterpart is `npm run value-gate:internal`; it is the required CI
gate and consumes no provider usage. It proves the same planner-to-worker
contract with deterministic provider fixtures.
