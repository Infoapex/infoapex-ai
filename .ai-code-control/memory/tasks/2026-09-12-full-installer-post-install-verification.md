# Task - 2026-09-12 - Full installer post-install verification

## Goal
Add a bounded post-install verification path and prevent a full install from creating
bootstrap state before the target is accepted.

## Context used
- The full installer must operate on a committed Git repository with current-user
  write access and must not silently replace differing bootstrap files.
- EuroCarScan exposed stale provider configuration; `install --check` now detects it.

## Changed files
- `src/cli.ts`
- `tests/cli.test.ts`
- `docs/P6-DX.md`
- `docs/adr/0004-full-install-and-readiness-preflight.md`

## Changes made
- Added `init --full --verify`, which runs the no-provider `preflight` immediately after
  a successful full install and returns `BLOCKED` when readiness is incomplete.
- Moved full-install bootstrap creation after target validation, preventing partial
  `.infoapex-ai` state for non-Git or invalid targets.
- Added explicit bootstrap conflict detection and required `--repair` for replacement.
- Added CLI regression coverage for verification and no-partial-state behavior.

## Validation
- `npm test`: PASS, 69/69 tests.
- `ai-code-worker doctor --engine fake --json`: PASS; local-isolated backend supported,
  network isolation limitations remain explicitly warned.
- `ai-code-control refresh --full` and `memory-health --fail-on-stale`: PASS.
- `node scripts/solo-release-audit.mjs --candidate v1.0.0-rc.1-internal`: PASS,
  `SOLO_INTERNAL_RC_READY`; clean ZIP smoke 14/14.

## Open issues
- EuroCarScan's installer-managed policy was repaired and both `install --check` and
  `preflight` now pass. Its pre-existing application/configuration changes remain
  uncommitted and were not reverted or committed by this task.
- Public `v1.0.0` still requires maintainer GO/NO-GO, protected tag and publication
  workflow; no publication was performed.

## Next recommended task
Prepare the maintainer decision for the public release gate; the EuroCarScan consumer
preflight is now ready for the bounded next run.
