# ai-code-docs

`ai-code-docs` generates durable project documentation through the existing
Infoapex CLI contracts.

## Ownership

- `ai-code-planner` defines and validates the documentation plan.
- `ai-code-control` supplies health, memory and code-context evidence.
- `ai-code-worker` executes the accepted documentation plan in its isolated
  worktree and owns provider invocation, commits and gates.
- `ai-code-review` performs the final read-only documentation review.
- `ai-code-docs` orchestrates these commands and emits a versioned report. It
  never imports their source code.

## Commands

```powershell
node dist/src/cli.js init --repo <project>
node dist/src/cli.js plan "Document the accepted implementation" --repo <project>
node dist/src/cli.js generate --repo <project> --request .ai-code-docs/request.json --planner-draft .ai-code-docs/drafts/docs.plan.json --engine codex --review-engine codex --out .ai-code-docs/reports/docs.json
node dist/src/cli.js ingest --repo <project> --report .ai-code-docs/reports/docs.json
```

`generate` fails closed unless planner validation, control context, worker execution
and the final review all pass. `fake` is deterministic and is used by CI; `codex`
and `claude` are delegated to the worker and review modules.

## Development

```powershell
npm install
npm test
```
