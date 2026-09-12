# P6 privacy lifecycle

The `core-local` profile keeps raw provider conversations, secrets, source excerpts,
environment dumps, and full diffs out of canonical memory, diagnostics, telemetry, and
release evidence. Diagnostics contain bounded status summaries, platform metadata,
redacted configuration explanations, and hashes only.

Retention is explicit and machine-readable. `production retention` first inventories
expired files in dry-run mode; apply mode deletes only regular files under the managed
`.infoapex-ai/diagnostics` root. Missing or malformed policy, traversal, and symlink
boundaries fail closed. Evidence remains local unless export is separately authorized.

Security reports are private and must not contain credentials, customer source, or raw
provider transcripts. Critical/high findings, scope escapes, secret leakage, invalid
signatures, and destructive recovery cannot be waived for a production release.
