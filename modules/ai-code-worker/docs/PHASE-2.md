# Phase 2 Implementation Notes

Phase 2 adds a second engine (Claude Code, headless) alongside Codex, and a DAG
scheduler capable of dispatching independent tasks as concurrent writers when the
manifest allows it. Delivered as three PRs on `agent/phase2-claude-dag`, each kept
green against the full existing test suite before the next started.

## Implemented: PR A — Claude adapter contract and doctor

- `src/engines/claude-cli.ts`: `ClaudeCliAdapter` mirrors `CodexCliAdapter`'s shape.
  `doctor()` parses `claude --version` and runs a
  capability smoke test against `claude -p --help`, failing closed
  (`CLAUDE_VERSION_UNAVAILABLE` / `CLAUDE_VERSION_UNTESTED` / `CLAUDE_SMOKE_TEST_FAILED`)
  when the CLI is missing, untested, or does not advertise the flags the adapter
  depends on.
- `doctor --engine claude|codex` is now wired into the `doctor` CLI command and
  `DoctorReport.engineDoctor` (previously `doctor` had no `--engine` flag at all).
- `start()` runs `claude -p` non-interactively via `spawnSync`, granting no Bash
  (`--tools "Read,Edit,Write,Grep,Glob"`), `--permission-mode dontAsk`,
  `--no-session-persistence`. Never writes raw Claude stdout to disk - only the mapped
  `EngineEvent[]`/`AgentExecutionResult`.
- Authenticates the same way an interactive `claude` session on the host machine does
  (OAuth/keychain from `claude login`, i.e. the developer's own subscription), not via
  `ANTHROPIC_API_KEY`. `--bare` (which would skip OAuth/keychain and require an API
  key) is opt-in via `ClaudeCliAdapterConfig.bareMode`, off by default. Confirmed with a
  live end-to-end `adapter.start()` call against a real subscription session, not just
  `doctor`.
- `--json-schema` was tried first (mirroring Codex's `--output-schema`) and then
  **removed**: a live smoke test against the installed CLI (2.1.177) showed it hangs
  indefinitely at runtime despite being advertised in `--help`, regardless of auth
  state, prompt delivery, or `--output-format`. Structured output is instead enforced
  by prompt instruction plus the adapter's existing client-side schema validation -
  same fail-closed guarantee, no dependency on a documented-but-broken CLI flag.
- `writeFakeClaudeCli()` test helper mirrors `writeFakeCodexCli()` so CI never calls a
  real model. Also fixed a bug where it hardcoded `runId`/`taskId` instead of reading
  them from the request - masked in early tests only because fixture IDs coincided with
  the hardcoded values.
- `src/engines/version-match.ts` extracted from `codex-cli.ts` (pure refactor) so both
  adapters share one version-range matcher.

## Implemented: PR B — `run --engine claude`

- `src/run/claude-run.ts` mirrors `codex-run.ts`'s structure exactly: worktree creation,
  dependency-closure cherry-pick, engine call, worker-owned commit, task gates, global
  gates, deterministic review, run report. `ClaudeCliAdapter` swapped in for
  `CodexCliAdapter`.
- `claudePrompt()` explicitly instructs the model to emit only the raw
  `AgentExecutionResult` JSON as its final message, and to never run
  `git commit`/`push`/`reset`/`clean` - defensive reinforcement since the adapter no
  longer relies on `--json-schema`.
- `--engine claude` wired into the `run` CLI command alongside `fake`/`codex`.

## Implemented: PR C — DAG scheduler, overlap guards, integration

Deliberately scoped to the **fake** engine - see "Deferred" below for why.

- `src/policy/concurrency-policy.ts`: `tasksOverlap()` blocks two tasks that share a
  `concurrencyKey` or have any pair of `allowedPaths` glob patterns that could match
  the same file (ancestor-or-equal directory-tree check, biased toward declaring
  overlap on ambiguous cases). `partitionIntoWaves()` greedily batches ready tasks into
  deterministic waves capped at `maximumParallelWriters`.
- `src/run/dag-scheduler.ts`: `nextDispatchWave()` composes the existing `readyTasks()`
  (unchanged from Phase 0) with `partitionIntoWaves()`. Proven by test to degenerate to
  exactly the pre-Phase-2 single-task-per-call sequence when
  `maximumParallelWriters === 1`.
- `src/git/cherry-pick.ts`: `cherryPickCommit()`/`cherryPickSequence()` wrap
  `git cherry-pick` with real conflict detection (conflicted paths + abort-on-failure,
  leaving the worktree clean). The pre-existing inline cherry-pick loops in
  `codex-run.ts`/`claude-run.ts` threw uncaught on conflict; `fake-run.ts`'s
  dependency-materialization step now uses this helper and fails closed instead.
- `src/run/integration.ts`: `integrateTaskCommits()` cherry-picks every passed task's
  commit, in deterministic topological order, onto a dedicated integration worktree.
  First conflict aborts and returns a conflict report (task, commit, conflicted paths) -
  never partial success. Wired into `fake-run.ts` after a run's wave loop completes,
  writing `conflict-report.json` (BLOCKED) or `integration-report.json` (OK).
- `src/git/sync-root.ts`: `enforceSyncRootForParallelDispatch()` always blocks (never
  warns) a wave of size > 1 under a detected sync root (OneDrive/Dropbox/iCloud/Google
  Drive), regardless of the repository's configured `syncRootPolicy` - stricter than
  `doctor`'s warn-capable check. `fake-run.ts` calls this before dispatching any
  multi-task wave and degrades to a single-writer wave if blocked.
- `fake-run.ts`'s flat `for (const taskId of graph.topologicalOrder)` loop became an
  outer wave loop wrapping the same per-task body, unchanged. Non-regression is
  enforced, not just claimed: the full pre-existing test suite passes unmodified
  (including the crash-recovery/idempotency test), and a dedicated scheduler test
  proves the `maximumParallelWriters === 1` case reproduces the exact prior task
  sequence.
- `schemas/event.schema.json` + `src/persistence/event-log.ts`: additive
  `"run.wave-dispatched"` event type.
- `scripts/phase2-demo.mjs` (`npm run phase2:demo`) exercises all four validation
  behaviors below against one fixture repository.

### Required validation (from the handoff)

```powershell
npm test
npm run phase0:demo
npm run phase2:demo
```

`phase2:demo` covers, in order: `doctor --engine claude` against the real installed
CLI; `run --engine claude` against a fake Claude CLI fixture (no real model call);
`run --engine fake` with two independent compatible tasks (single wave, deterministic
integration); `run --engine fake` with two tasks sharing overlapping `allowedPaths`
(never dispatched in the same wave even under a higher parallel cap).

`doctor --engine claude|codex --json` and `run --engine claude|codex|fake --json` are
also directly runnable against any repository fixture via `dist/src/cli.js`.

## Closed post-dogfooding robustness items

The five ordered follow-up items previously tracked in [../todo.md](../todo.md) were
implemented on 2026-08-12 before Phase 3:

- `doctor()` now includes behavioral smoke checks that block the known-broken structured
  output flags from re-entering runtime invocations.
- `CodexCliAdapter` and `ClaudeCliAdapter` now expose `startAsync()` backed by async
  `spawn`, with timeout and output caps, so real engine calls are no longer technically
  constrained by `spawnSync`.
- Quality gates can declare `linkedDirectories` to link runtime dependencies such as
  `node_modules` from the repository checkout into task worktrees before running real
  build/test commands.
- `LocalIsolatedExecutionEnvironment` replaced the fake backend in `doctor` and verifies
  scrubbed environment execution, no-shell process launching, timeout/output limits and
  cleanup. It still warns that local network-deny is policy-visible rather than a
  kernel-level network sandbox.
- `.ai-code-worker/config.json` and CLI flags can configure common adapter settings
  without editing source code.

Wave-based commit integration remains deliberately conservative for `codex-run.ts` and
`claude-run.ts`: they can use async adapters, but still keep one worker-owned commit at a
time so recovery and task-gate sequencing remain deterministic.
- The Claude adapter authenticates via OAuth/keychain by default (the same subscription
  session an interactive `claude` login already provides), not `ANTHROPIC_API_KEY`.
  `bareMode: true` is available for an unattended environment deliberately provisioned
  with an API key instead of a logged-in session (e.g. CI without an interactive
  session to log in), but is opt-in, not required. The Codex adapter already
  authenticated via subscription with no code change needed - confirmed live against a
  ChatGPT-subscription install (see "Dogfooding" below).
These boundaries feed Phase 3 (repair/replanning) and Phase 5 (SDK adapters), but are no
longer open TODO prerequisites.

## Dogfooding: `--claude-executable`/`--codex-executable` built through the worker itself

Rather than write it by hand, this flag pair was implemented by running real
`run --engine claude` and `run --engine codex` tasks through `ai-code-worker` against
its own repository, under the developer's own subscriptions for both providers (no
`ANTHROPIC_API_KEY`, no `OPENAI_API_KEY`). Real bugs surfaced that no fake-CLI unit test
could have caught, because a fake CLI necessarily can't reproduce quirks of the real
CLI it doesn't know about - fixed in the adapters, not worked around per-task.

### Claude leg

1. `--session-id` requires a valid UUID on the real CLI; the worker's own descriptive
   session identifier isn't one. Fixed by generating a fresh UUID per invocation.
2. `--tools` makes a tool available; under `--permission-mode dontAsk` that alone does
   not permit its use - Edit/Write were auto-denied on a live run despite being in
   `--tools`. Fixed by also passing `--allowedTools` with the same list.
3. Despite an explicit "respond with ONLY the JSON object" prompt instruction, the
   model's final message sometimes still included a lead-in sentence. Fixed by falling
   back to extracting the outermost `{...}` substring, still schema-validated after.
4. Claude Code versions that expose a read-only sandbox for non-interactive writers can
   be run with the explicit `bypassPermissions`/`--dangerously-skip-permissions` opt-in.
   The worker never enables this by default; if the provider still returns a sandbox or
   permission failure, routing classifies it as an availability signal and can advance
   to a configured Codex candidate.

A first attempt at the task itself also revealed a scoping lesson, not an adapter bug:
with `allowedPaths` scoped to `src/cli.ts` only, the model could not touch
`src/doctor/doctor.ts`, so it satisfied the (too-shallow) grep-based verify commands
via an `as` type-assertion around a nonexistent option field - compiled, but was a
no-op at runtime. The task's own gates could not fail-closed catch this because they
were necessarily grep-based, not a real build+test (task worktrees don't have
`node_modules` - not tracked by git). Caught by manual diff review before merging, not
by the run's own `DONE` status; re-run with `allowedPaths` correctly covering both
files, plus a verify command explicitly forbidding the `as Parameters` escape hatch,
produced a genuinely correct diff. Lesson for future task authors: grep-based verify
commands can confirm a string exists, never that it does anything - review the diff
for tasks whose correctness can't be fully captured by a no-`node_modules` gate.

### Codex leg

Confirmed live against a real ChatGPT-subscription Codex install (`auth_mode: chatgpt`
in `~/.codex/auth.json`, version `0.136.0-alpha.2`): `--ignore-user-config`/
`--ignore-rules` do not break subscription auth, and `danger-full-access` (the existing
Phase 1 default) genuinely writes files - `workspace-write` still reports read-only on
Windows, the same pre-existing issue already documented for a different Codex version
in `docs/PHASE-1.md`.

The orchestrated task itself failed four times before succeeding, each for a distinct,
real reason:

1. **`--output-schema` tool misuse** (3 attempts, including with an explicit prompt
   instruction against it): the flag exposes a structured "final answer" tool that the
   model reliably invoked as its very first response, before doing any real work, then
   got stuck ("Cannot execute shell commands after response-format tool misuse in this
   turn"). A prompt fix alone did not resolve it. Fixed by removing
   `--output-schema`/`--output-last-message` entirely - the adapter now reads the last
   `agent_message` from the `--json` JSONL stream instead, with the same prose-tolerant
   extraction plus client-side schema validation used for the Claude adapter. This
   removes the tool the model was prematurely reaching for rather than trying to
   out-prompt it.
2. **`maxBuffer` too small**: `spawnSync`'s default 1 MiB was exceeded by a task reading
   several real source files, since `codex exec --json` echoes each command's full
   output (including whole file contents) back inside `aggregated_output` fields. The
   failure looked identical at both a 20-minute and a 35-minute `timeoutMs` - a size
   limit, not a time limit, which is what pointed at the real cause. Raised the default
   to 20 MiB.
3. **`.cmd` executable invocation**: a real Codex-authored test for
   `--claude-executable`/`--codex-executable` used a full path to a `.cmd` fixture,
   which failed with `EINVAL` - Windows cannot execute `.cmd`/`.bat` files directly via
   `CreateProcess` without `shell: true`. Not just a test-fixture concern: a real
   `--claude-executable`/`--codex-executable` pointed at an npm-global `.cmd` shim
   (common on Windows) would hit the same failure. Fixed narrowly (`.cmd`/`.bat`
   executables only) after a broader "always `shell: true` on Windows" attempt broke
   invoking `node.exe` itself from its normal `C:\Program Files\nodejs\node.exe` install
   path - `shell: true` does not quote the executable portion of the command line, only
   the arguments. The regression was caught immediately by 9 previously-passing
   fake-CLI tests turning red before it ever reached a commit.
4. The real Codex-written test file itself also had a batch-scripting authoring
   mistake, unrelated to the adapter: literal parentheses inside an `echo` that is
   itself inside an `if (...)` block truncate the output in Windows batch parsing.

## Validation

```powershell
npm test
npm run phase0:demo
npm run phase2:demo
```
