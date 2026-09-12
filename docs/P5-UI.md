# P5.2 local read-only evidence UI

The root CLI can render a static HTML summary of local run state and bounded recovery
evidence:

```text
infoapex-ai ui --repo <path> [--run-id <id>] [--out <relative-path>]
```

The command never starts a server, contacts a provider, uploads data, or executes a
run. It reads `.infoapex-ai/runs/<run-id>/` and renders only status, bounded metadata,
task identifiers/statuses, commit ids, event count, and the last event type. Event
payloads, raw process output, recovery messages, and secrets are omitted by design.

Without `--out`, HTML is written to stdout. With `--out`, the destination must remain
inside the target repository. The output is a standalone document with a restrictive
Content-Security-Policy and no external resources.

An absent run directory is a valid empty view. Invalid JSON evidence is shown as a
bounded warning and does not become a success claim about the underlying run.
