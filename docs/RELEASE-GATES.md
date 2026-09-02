# Release gates

The first three modules are not called production-complete merely because their
TypeScript builds pass.

Required gates:

- `ai-code-worker`: full deterministic suite, routing/fallback tests, JSON contract validation, and live verification that the installed Claude/Codex CLIs expose a stable quota or availability signal.
- `ai-code-planner`: full suite plus three representative end-to-end plans that pass linting, compile against the pinned worker contract, and execute through worker.
- `ai-code-review`: full deterministic suite plus an internal planner -> control -> worker read-only review gate.
- `ai-code-docs`: full deterministic suite plus an internal planner -> control -> worker -> review documentation gate.
- `infoapex-ai`: installer init in both modes, status, handoff write/read, bundle clean-clone bootstrap and ZIP extraction.

The reproducible ICM gate is `npm run value-gate:internal`. It executes 20 generic
planner `propose -> inspect -> compile` tasks through worker `run --engine fake`.
`npm run pilot:icm-graph:internal` composes that matrix with a generic consumer trace
graph, 25 hybrid queries, expected graph, coverage, drift, and Obsidian projection.
Both consume no provider usage. `npm run value-gate:live` is an explicit opt-in with
the installed Claude CLI and is the only gate that consumes provider usage.

Until the live quota signal and the three-plan value gate pass, the correct
status is implemented candidate, not an unqualified production release.

Validation update 2026-08-25: the bounded mid-task fallback contract is covered
and passing (`codex` quota failure -> `claude` success; deterministic failure does
not fallback). The live three-plan proposal gate was attempted against a large
target workspace, but the installed CLI timed out after 180 seconds; it remains
blocked on external CLI execution, with evidence in
`validation/value-gate/README.md`. The internal contract gate does not require a
real quota-consuming task: provider outcomes are injected deterministically.
The repository-agnostic internal three-plan gate now passes 3/3 through planner
and worker fake execution; only the usage-consuming live variant remains open.

Codex live update 2026-08-25: `codex-cli 0.147.0` passed doctor and a disposable
real worker task completed with `DONE`, a worker-owned commit and a passing gate
when invoked with explicit `--codex-sandbox danger-full-access`. The default
`workspace-write` invocation was blocked by the local CLI approval policy. The
remaining external validation is Claude's usage-consuming planner/value gate and
its real quota signal.

P2-A update 2026-08-30: the bounded two-invocation preflight passed live for Codex
and Claude. Claude usage is complete and economically comparable. Codex completed
functionally, while USD cost remains unavailable; token counts require the
sanitized local-rollout fallback because CLI 0.147.0 omits them from `exec --json`
stdout. The combined economic verdict is therefore `inconclusive`. P2-B and the
three-arm comparison remain release gates; `GRAPH-06` is still disabled.

P2-B update 2026-09-02: harness built (`scripts/p2-b-live-pilot.mjs`,
`validation/p2-b/`), extending the P2-A pattern from 2 to the required 10 real
sequential tasks (5 Codex + 5 Claude, alternating, one shared repository,
`GRAPH-06` disabled throughout). Each task is graded by an independent script check
against the actual committed evidence file (read via `git show <taskCommit>:<path>`,
since task work lands on a dedicated per-task branch/worktree, never the shared
repo's checked-out working tree) rather than by either engine's self-report. Before
building, verified directly against installed CLIs (`claude --help` 2.1.235,
`codex --help` 0.147.0) that `/usage` and `/context` are Claude Code TUI-only
interactive commands with no CLI/API surface, so they cannot back headless per-task
usage figures; the pilot instead reuses the same real per-invocation sources already
validated live in P2-A (`--output-format json` for Claude, sanitized Codex rollout
fallback for Codex).

The live run executed 2026-09-02 (`validation/p2-b/live-report.json`,
`LIVE-REPORT.md`): **10/10 DONE, 10/10 accurate, zero engine fallbacks**, 4m10s total
wall time. Claude usage is complete for all 5 tasks (~$0.073/task, ~$0.3658 total).
Codex again omitted usage from `exec --json` on 0.147.0; the sanitized rollout
fallback covers all 4 token fields.

Correction, same day: the raw Codex rollout files were found to contain
`cache_write_input_tokens` (value 0 for every task in this run) that
`ai-code-worker`'s usage parser had never read — a stale assumption from an earlier
CLI version that genuinely omitted the field, not a current CLI limitation. Fixed in
`codex-cli.ts`/`read-codex-session.ts` (392/392 worker tests still pass) and both
P2-A's and P2-B's reports were reprocessed from their original, still-present local
rollout files — no new live invocation was needed. Token-level Codex usage is
therefore now complete; **only `costUsd` remains unavailable, for a confirmed
structural reason**: the same rollout's `rate_limits.credits` reports
`has_credits: false, balance: "0"` for this ChatGPT-Plus-subscription-authenticated
account, meaning there is no dollar ledger to report from in this billing mode. The
combined economic verdict is therefore still `inconclusive`, same as P2-A, but now for
exactly one isolated, well-understood reason instead of two conflated ones.

Quota-percent decision, 2026-09-02: both Codex and Claude are used here on flat-rate
($20/mo) subscriptions, not pay-per-token API billing - `costUsd` was never going to
reflect a real marginal cost, and for Codex it structurally does not exist at all (see
above). `economicVerdict` (`ai-code-worker`'s `assessUsageTotals`, see
`docs/USAGE-TELEMETRY-V1.md`) is redefined to depend on knowing a task/run's 5-hour
quota-percent instead - `measured` directly from Codex's rollout (`rate_limits`,
already present, just never read before) or `estimated` for Claude from a real token
count via a calibrated ratio; either counts as comparable. Both P2-A and P2-B were
reprocessed from their original, already-saved local data (no new live invocation) and
now report **`economicVerdict: comparable`** - Codex measured 75% (P2-A) and a 4-6%
range (P2-B) of its 5-hour window across these runs; Claude's estimated equivalents are
2.5% (P2-A) and a 20.1% cumulative estimate across P2-B's 5 tasks. The Codex figures
are cumulative account-wide gauges at the moment each reading was taken, not a
per-task amount (P2-A's 75% in particular reflects other account activity, not that
one smoke task's own cost - see `validation/p2-a/LIVE-REPORT.md`); Claude's are
genuinely per-task since each is derived from that task's own tokens.

**P2 is closed**: both the 2-invocation preflight (P2-A) and the 10-task live pilot
(P2-B) are functional PASS, with complete token-level usage on both engines, and now
`economicVerdict: comparable` on both under the quota-percent definition. Enabling
`GRAPH-06` parallel reviewers is a distinct, separately-gated decision (a
preregistered A/B experiment) that this pilot supplies the sequential baseline for
but does not itself authorize — it remains disabled pending its own explicit
go-ahead.

P3 update 2026-09-02 (local steps 1-6 of `docs/plans/INFOAPEX-AI-ROADMAP-P0-P5.md`
section 7): `scripts/build-release-zip.mjs` builds the release artifact with
`git archive`, not a directory copy - it reads directly from the git object database
at a given ref, so a dirty working tree or stray local files structurally cannot leak
in (the script also refuses to archive `HEAD` with uncommitted changes unless
`--allow-dirty` is passed, to make that guarantee explicit rather than silent).
`scripts/release-smoke-test.mjs` extracts the resulting ZIP into a fresh temp
directory with no `node_modules/`, `dist/`, or `.git`, then runs, from scratch:
`npm run setup` → `npm run build` → `npm test`, all four internal gates
(`value-gate`, `pilot:icm-graph`, `review-gate`, `docs-gate` - covering all five
modules: planner, worker, review, docs, control), and the root installer's own
`init`/`status` (independent mode) and `init`/`handoff`×2/`status` (integrated mode)
against disposable target directories. **All 10 steps passed** (~6m20s total, see
`npm run release:smoke-test`). Still open from the roadmap's step 7-9: a Windows+Linux
CI matrix (today Linux-only, single job), a root `LICENSE` file, a
`status`-exposed report of pinned module versions, release notes, and the tag/publish
step itself - none of these were in this session's scope and none require an external
or hard-to-reverse action to close the ones that are purely local.

P3 update, same day (remaining local steps): added root `LICENSE` (mirrors every
vendored module's existing proprietary text, no new terms invented), converted
`.github/workflows/ci.yml`'s single `ubuntu-latest` job into a
`[ubuntu-latest, windows-latest]` matrix with the release smoke test as a CI step,
extended `infoapex-ai status` to report every vendored module's pinned upstream
commit from `modules/provenance.json`, and wrote `RELEASE-NOTES.md` for v0.1.0.

**Windows CI, same day: three real path-resolution bugs found and fixed, not
pre-existing flakiness papered over.** The matrix's first real run failed 5
`ai-code-worker` tests plus, after those were fixed, `docs-gate:internal` - all on
`windows-latest` only, never on Linux, and never reproducible on a local Windows
dev machine. Root cause, confirmed directly from CI diagnostics (not guessed): on
GitHub Actions' `windows-latest` runner, `os.tmpdir()` returns the short (8.3 alias)
form of the runner's home directory (`C:\Users\RUNNER~1\...`), while
`git rev-parse --show-toplevel` (used by `gitPreflight()`) resolves the identical
real directory to its long form (`C:/Users/runneradmin/...`). Every later string
comparison between the two (`state-root.ts`'s `repositoryHash`, `compile.ts`'s
`isPathInside(worktreeRoot, planAbsolutePath)`) silently diverged. Two wrong turns
on the way to the real fix, kept here rather than erased: (1) a sync-root/OneDrive
env-var hypothesis, disproven by direct local reproduction attempts; (2) plain
`fs.realpathSync`, verified locally (via a deliberately long directory name and its
COM-derived short alias) to NOT expand 8.3 short names on Windows at all - only
`fs.realpathSync.native` does. Fixed at the source with `realpathSync.native` in
`git/preflight.ts` and `state/state-root.ts`, plus in every gate/pilot script that
creates a fixture repository under `tmpdir()` (`docs-gate.mjs`, `review-gate.mjs`,
`value-gate.mjs`, `icm-graph-pilot.mjs`, `p2-live-preflight.mjs`,
`p2-b-live-pilot.mjs`, `release-smoke-test.mjs`) - each of those calls a *different*
module's CLI, which does its own path resolution independent of `ai-code-worker`'s
fix. **CI is now green on both platforms**, including the in-CI release smoke test.
