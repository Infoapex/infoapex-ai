# ADR-0004: Full install and readiness preflight

- Status: accepted
- Date: 2026-09-06

## Context

The old root `init` created only `.infoapex-ai/`. A consumer repository could show
`status: DONE` while it had no canonical memory, no agent rules, no review/docs
configuration, a worker without an explicit provider policy, and module commands
pointing at paths that did not exist in that repository.

EuroCarScan exposed the resulting failure mode: the generic `dotnet-nextjs` template
assumed `api/` and `web/`, while the approved project structure is
`backend/`, `frontend/`, and optional `ml/`. The control provider also needs its SQLite
caches initialized before worker context calls are attempted.

## Decision

`infoapex-ai init` remains a backwards-compatible handoff bootstrap. `init --full`
installs a named **technology** profile and `preflight` is the strict readiness gate before a
live P5 run. Consumer repository names are never profiles.

The initial profiles are `generic` and `dotnet-nextjs`. The latter takes reusable
`--backend-dir`, `--frontend-dir`, and optional `--ml-dir` settings (defaulting to
`backend`, `frontend`, and `ml`), so it does not encode a consumer's directory names.
A full install:

1. creates canonical Markdown memory, `TODO.md`, `AGENTS.md`, and `CLAUDE.md` without
   overwriting user-authored seed files;
2. creates profile-specific control validation paths;
3. initializes rebuildable control caches;
4. writes review/docs command configurations using the exact installed bundle paths;
5. configures one explicit Codex provider/model/effort and a routing policy with no
   automatic engine fallback;
6. records the bundle path in an install profile so moving the bundle is detected;
7. requires `--repair` before replacing a differing installer-owned configuration.

`preflight` invokes no coding provider. It verifies files and provenance, provider
policy, control health/brief, and worker/review/docs doctors. A failed check blocks P5.
The installer builds the local control CLI once and wiring invokes its built DLL;
repeated health checks do not use `dotnet run` or start a compiler per check.

## Consequences

The bundle path is deliberately explicit in P6.0. This makes an external-bundle
installation work today and fails closed after relocation. Portable package launchers,
upgrade/rollback, signed artifacts, and support matrices remain P6 lifecycle work and
are not implied by this decision.
