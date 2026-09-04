# Versioned contracts

BENCH-02 publishes exactly ten Draft 2020-12 contracts. Their `$id` values are stable
`https://infoapex.dev/schemas/ai-code-benchmark/*-1.0.json` URLs, so Ajv resolves the
experiment-to-environment reference without network access. Objects are closed by
default; only documented metadata/configuration maps are open. `null` means unknown,
never zero or omitted data.
