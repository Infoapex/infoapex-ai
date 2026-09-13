# Changelog

## Unreleased

- P6 `core-local` full installer and strict preflight.
- Configuration validation, migration backup, and rollback foundation.
- P6 release-gate registry and local CycloneDX SBOM generation.
- P6 npm packaging allowlist and runtime-content gate; local validation state is
  excluded from the publicable package.
- P6 npm package smoke test from a fresh install with root and delegated CLI checks.
- P6.7 developer quickstart, consumer examples, troubleshooting, and a preregistered
  pilot contract that remains NOT_STARTED until real consumer evidence exists.
- P6.8 local RC audit/evidence index and fail-closed GA decision package; publication is
  intentionally disabled until external pilot, audit, and owner sign-offs exist.
- Solo-maintainer public-release preflight now requires an explicit committed Go/No-Go
  decision and verifies the tagged artifact, checksum, provenance, SBOM, and signed
  release workflow before any publication step.
- Full installation now supports `--verify` for an immediate no-provider preflight,
  blocks partial bootstrap state on invalid targets, and requires `--repair` before
  replacing a differing bootstrap file.
- Installation readiness now reports effective repository write access and bundle
  runtime read access in both `preflight` and `install --check`; no ACLs are widened
  automatically.
- Release artifacts now include a deterministic committed-policy manifest; the public
  workflow validates and attests it separately from the ZIP and SBOM.
- Stable-release preflight now requires a concrete OS-isolated execution boundary;
  policy-visible isolation warnings can no longer be promoted to `v1.0.0`.
- Full installs now persist an ownership manifest, and `uninstall --keep-data`
  removes only unchanged installer-owned integration files while preserving state,
  evidence, backups, run history, and project bootstrap.
- Full-install writes are now transactional: conflicts or filesystem/control-init
  failures roll back installer-managed files and preserve the consumer's files.
- The solo RC audit now includes the offline npm-package smoke test as a separate
  artefact-boundary gate.
