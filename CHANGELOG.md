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
