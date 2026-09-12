# ADR-0007: Local read-only evidence UI

## Status

Accepted for the P5.2 local UI subproject.

## Decision

Provide a static HTML renderer behind `infoapex-ai ui`. It reads bounded local run
evidence and emits a document to stdout or an explicitly selected path inside the
target repository. It does not run an HTTP server and has no network capability.

The renderer exposes navigation metadata only: run state, task status, commit ids,
event count, last event type, and bounded recovery status. Raw event payloads, process
output, provider responses, and recovery messages are never copied into the document.
Invalid evidence is represented as a warning, not silently ignored as a successful
run.

## Security and privacy boundary

- the repository and run id are resolved locally and run ids are allow-listed;
- output paths must stay inside the target repository;
- HTML values are escaped and truncated at bounded lengths;
- the document contains no scripts or external resources and declares a restrictive CSP;
- the command is read-only with respect to run state and does not upload or publish.

## Consequences

The UI is useful for local inspection and support navigation but is not a replacement
for the signed evidence bundle, independent audit, or consumer pilot required by P6.
