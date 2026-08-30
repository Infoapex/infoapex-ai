# Usage telemetry v1

Usage telemetry is evidence, not an estimate. Unknown provider fields stay
`null`; they are never converted to zero. Every run report carries a separate
assessment:

- `complete`: all token and reported-cost fields are known;
- `partial`: at least one field is known and at least one is unknown;
- `unavailable`: no usage field is known;
- `comparable`: only a complete report may support an economic comparison;
- `inconclusive`: execution may still succeed, but no economic claim is allowed.

`normalized-usage.schema.json` versions the machine contract. Samples identify a
provider parser version, invocation series, sequence and accounting mode.
Incremental samples are summed. For a cumulative series only the highest sequence
contributes. Identical replayed `sampleId` values are deduplicated; content drift
or mixed accounting modes fail closed.

This distinction covers retries, fallback and resume:

- a retry or fallback is a new invocation series and its real usage is added;
- replaying an already persisted sample after resume does not add it again;
- repeated cumulative provider events do not inflate the total;
- missing cost or cache fields make the economic verdict `inconclusive`, without
  turning a functionally valid run into a failure.

Current sanitized parser fixtures are:

- `tests/fixtures/engine-usage/codex-rollout-token-count.sample.jsonl` for
  `codex-token-count.v1`;
- `tests/fixtures/engine-usage/claude-output-format-json.sample.json` for
  `claude-result.v1`.
