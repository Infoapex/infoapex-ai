# P6 core-local threat model

Trust boundary: one explicitly authorized local repository. Provider output, plans,
Git contents, filesystem paths, and subprocess output are untrusted inputs.

Controls: structural argument arrays (no shell interpolation), repository-relative
path validation, output/time bounds, one atomic writer lease, explicit provider/model,
provider-boundary capability checks,
no silent fallback, export-off telemetry, redacted diagnostics, verified backups, and
fail-closed release gates. Secrets and raw conversations are forbidden evidence.

The current `local-isolated` implementation applies environment, timeout, output and
process-tree controls, but cannot prove host-level filesystem/network isolation or
isolate the Codex/Claude provider process. It is
therefore not an accepted production backend. `node scripts/isolation-preflight.mjs`
fails closed unless the worker doctor reports an `os-isolated` boundary,
`providerSupported: true`, every required capability, and no unverifiable warnings.
The public-release workflow runs this gate
before attestation and publication.

Production release requires an accepted OS/container backend (or an equivalent proven
native sandbox); an explicit no-go is the only valid outcome while that evidence is
missing.
