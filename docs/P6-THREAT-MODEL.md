# P6 core-local threat model

Trust boundary: one explicitly authorized local repository. Provider output, plans,
Git contents, filesystem paths, and subprocess output are untrusted inputs.

Controls: structural argument arrays (no shell interpolation), repository-relative
path validation, output/time bounds, one atomic writer lease, explicit provider/model,
no silent fallback, export-off telemetry, redacted diagnostics, verified backups, and
fail-closed release gates. Secrets and raw conversations are forbidden evidence.

Residual limitation: the local backend cannot prove host-level network isolation.
Production release requires an accepted isolation backend or an explicit no-go verdict.
