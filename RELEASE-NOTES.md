# Release notes

## v0.1.0 (pre-release, private) — 2026-09-02

First private bundle candidate. This is an **implemented candidate, not a production
release** — see [Known limits](#known-limits) and [Open gates](#open-gates) below
before distributing or relying on it for anything beyond controlled internal use.

### What's in this release

- `infoapex-ai` root CLI: `init` (independent/integrated mode), `status` (now reports
  the pinned upstream commit for every vendored module), `handoff`.
- Five bundled modules, each independently runnable and independently tested:
  `ai-code-planner`, `ai-code-worker`, `ai-code-review`, `ai-code-docs`,
  `ai-code-control`. Pinned versions: see `modules/provenance.json` or
  `infoapex-ai status --repo <path>`.
- Deterministic internal gates, all passing and consuming no provider quota:
  `value-gate:internal` (20-task ICM matrix), `pilot:icm-graph:internal` (25 hybrid
  trace-graph queries), `review-gate:internal`, `docs-gate:internal`.
- Live-validated usage/cost telemetry: real per-task token accounting for both Codex
  and Claude, and a 5-hour quota-percent economic comparison (`measured` for Codex,
  `estimated` for Claude — see `docs/RELEASE-GATES.md`) validated against 12 real
  provider invocations (P2-A: 2, P2-B: 10) — `economicVerdict: comparable` on both.
- A reproducible release artifact: `npm run release:build-zip` builds a ZIP via
  `git archive` (so it can only ever contain committed files — no local dev state can
  leak in) with a sha256 checksum and manifest; `npm run release:smoke-test` extracts
  it into a clean directory and verifies `setup` → `build` → `test` → all four
  internal gates → the root installer in both modes, all from scratch. Passing as of
  this release, in CI, on both Windows and Linux.
- Three real, Windows-specific path-resolution bugs found and fixed by that CI matrix
  the day it first ran: `git rev-parse --show-toplevel` and Node's own path handling
  can disagree on a directory's canonical form (short 8.3 alias vs long form) on
  GitHub Actions' `windows-latest` runner. Fixed at the source
  (`fs.realpathSync.native`) in `ai-code-worker`'s `gitPreflight`/`resolveStateRoot`
  and in every gate/pilot script's fixture-root creation — see
  `docs/RELEASE-GATES.md` for the full diagnostic trail.

### Known limits

- Not a replacement for Codex or Claude's own reasoning; this is process/governance
  tooling layered on top of them.
- The `fake` engine verifies orchestration wiring, not real-provider output quality.
- Worktree isolation and scope verification are not an operating-system-level sandbox.
- Codex invocation still requires explicit `--codex-sandbox danger-full-access`; the
  default `workspace-write` mode is blocked by local CLI approval policy.
- `costUsd` is structurally unavailable for Codex under a ChatGPT-Plus-subscription
  account (confirmed: `rate_limits.credits.has_credits: false` — no dollar ledger to
  report from in this billing mode). This is why economic comparison here is based on
  5-hour quota-percent, not USD cost.
- The Claude calibration table (`claude-calibration.ts`) is seeded from 2026-08-14
  development sessions, not production-shaped tasks; it has not yet been refreshed
  with a real `/usage` reading from a P2-B-style production task.
- The root `infoapex-ai` CLI is a thin bootstrap (`init`/`status`/`handoff`), not yet
  a unified CLI for `plan`/`run`/`review`/`docs` (planned for P4).
- Provider-neutral discovery (Gemini, Grok, Kimi, etc.) is out of scope; supported
  engines today are `fake`, `codex`, and `claude`.

### Open gates

Tracked in detail in [`docs/RELEASE-GATES.md`](docs/RELEASE-GATES.md) and
[`todo.md`](todo.md). As of this release:

- **CI**: the Windows+Linux matrix and the in-CI release smoke test are green as of
  this release (confirmed on a real run after fixing the three path bugs above).
- **`GRAPH-06`** (parallel independent reviewers) remains disabled pending its own
  preregistered A/B experiment and explicit authorization; the sequential baseline it
  depends on now exists (P2-B), but that does not itself authorize the experiment.
- **Tag and publish**: this version has not been tagged or published anywhere yet.
- Bundle-relative packaging (npm `files` allowlist, `.npmignore`) has not been
  reviewed for what a real `npm publish` would include.
