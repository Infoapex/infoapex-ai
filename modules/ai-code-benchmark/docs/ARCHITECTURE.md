# Architecture

The benchmark is an independent Node.js package. It interacts with provider CLIs and
`infoapex-ai` through subprocesses and JSON output only; it never imports their source
or runtime APIs. Commands are spawned with `shell: false`, fixed configured executable
and argument prefixes, bounded output, and an environment allowlist that excludes
secret-looking names.

Direct Codex and Claude adapters preflight their structured-output capabilities. The
Infoapex root adapter preflights root CLI help and reads only the isolated repository's
public worker JSON configuration: no-ICM is explicitly `none`/`off`; full ICM is
explicitly `ai-code-control` with an enabled context package. A failed preflight returns
`UNSUPPORTED`; no adapter silently changes provider or arm.

The public configuration separates target-repository configuration from the benchmark
state root. Operators must select a state root outside the target repository before an
experiment can run. Future live execution additionally requires explicit authorization
and bounded capabilities.

BENCH-04 derives and freezes a deterministic observation matrix from the experiment
hash. Arm order uses a per-task Latin rotation and every observation has a stable
idempotency key, ID, and seed. The runtime uses a fresh, symlink-free safe copy for each
observation, never shares workspaces between arms, and deletes only the canonical path
named by that observation's immutable cleanup record.

Atomic step snapshots are the recovery source of truth. The validated JSONL event log
is append-only except that recovery may discard an invalid, truncated final line. A
terminal observation is never executed again; a killed execution without a result is
retried from a new pristine copy, while a persisted execution resumes at the evaluator
handoff. The evaluator handoff is intentionally only an extension point until BENCH-06.
