# ai-code-review

`ai-code-review` is the read-only milestone and repository review module for the
Infoapex AI coding tools.

## Ownership

- `ai-code-planner` defines and validates the review scope and acceptance criteria.
- `ai-code-control` supplies memory, health and code-impact context.
- `ai-code-worker` owns provider invocation, read-only isolation and the versioned
  independent-review result schema.
- `ai-code-review` orchestrates those CLI contracts and emits a durable review report.

The modules communicate through CLI arguments, JSON and versioned schemas. The review
module never imports their source code.

## Commands

```powershell
node dist/src/cli.js init --repo <project>
node dist/src/cli.js plan "Review the implementation against the release criteria" --repo <project>
node dist/src/cli.js doctor --repo <project> --engine codex
node dist/src/cli.js run --repo <project> --request .ai-code-review/request.json --planner-draft .ai-code-review/drafts/review.plan.json --engine codex --out .ai-code-review/reports/review.json
node dist/src/cli.js ingest --repo <project> --report .ai-code-review/reports/review.json
```

`run` is fail-closed. A missing planner validation, control health/brief, worker result
or schema-valid review cannot become `PASS`. The review provider is read-only and never
receives an automatic repair capability.

The `fake` engine is deterministic and is used by CI. `codex` and `claude` are delegated
to `ai-code-worker review`; provider-specific sandbox and output handling remains owned by
the worker.

## Development

```powershell
npm install
npm test
```
