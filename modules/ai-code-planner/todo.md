# TODO — ai-code-planner

## Finalizat în implementarea planner v1 (2026-08-25)

- Provider de context opțional prin CLI-JSON, cu stări explicite `OK`/`UNAVAILABLE`/`ERROR` și continuare independentă.
- Rutare logică per task, clasificare deterministă către tipurile worker v1 și validare înainte de export.
- Replanificare deterministă prin `replan` după feedback worker, cu proveniență și taskuri afectate.
- Verificat: 31 teste planner, 53 fișiere JSON validate, task sintetic planner -> worker cu engine fake, handoff integrat bidirecțional și replan pe feedback `BLOCKED`.

## Restant operațional (nu blocaj de implementare)

- Poarta separată cu 3 planuri reale consumer project nu a fost consumată în acest batch; fluxul sintetic și contractul real planner-worker sunt verificate.
- Failover-ul în timpul taskului la epuizarea cotei/tokenilor rămâne deschis până când CLI-urile oferă un semnal sigur care separă quota failure de eșecul taskului.

## Rezolvat (2026-08-16)

- ~~**ai-code-control indexing is not actually wired up for this repo.**~~ **FIXED.**
  Added `ai-code-control` as a bundled module (`modules/ai-code-control`),
  matching the exact working pattern already proven in the consumer project repository.
  Fixed `.mcp.json` to point at the correct nested path
  (`ai-code-control/tools/ai-code-control/mcp-server/dist/server.js`, was missing the
  `ai-code-control/` prefix) with the same `ACC_TOOL_ROOT`/`ACC_TOOL_TIMEOUT_MS` env
  vars consumer project uses. Built both halves the submodule needs (neither is committed,
  matching upstream's own `.gitignore`; a fresh clone must rebuild them — see
  `ai-code-control/tools/ai-code-control/CONNECT.md`):
  - `dotnet publish tools/ai-code-control/src/AiCodeControl.Cli -c Release -o tools/ai-code-control/bin/publish`
  - `cd tools/ai-code-control/mcp-server && npm ci && npm run build`

  Verified for real (not just wired): ran `health-check`, `index-code --full`,
  `memory-ingest`, `refresh --full` directly via the published CLI
  (`ai-code-control/tools/ai-code-control/bin/publish/AiCodeControl.Cli.exe`) with
  cwd set to this repo. `index-code` correctly reports 0 files — Phase 0 has no
  runtime by design, only Markdown/JSON, and the indexer covers C#/TS/JS/SQL. Memory
  ingestion picked up the new Phase 0 task summary
  (`.ai-code-control/memory/tasks/2026-08-16-phase-0-remainder.md`):
  `memory-health` reports 4 items indexed, zero unindexed/changed/orphaned files.

  **Still open, not fixed here:** `.ai-code-control/config/memory-control.json`'s
  `include` list does not cover `docs/adr/**` or `docs/*.md` — the ADRs and
  `LINTER-CONTRACT.md` are real project decisions but are not picked up by
  `memory-ingest` automatically. Worth deciding before Phase 1 produces more ADRs
  whether to widen the include list or keep relying on manual task summaries.

## Restant (2026-08-16, Phase 1)

- Optional `infoapex-ai` bidirectional handoff is implemented locally: `compile` publishes `planner-to-worker.json` when the target repository has initialized Infoapex AI integration, and `ingest-worker-report` reads `worker-to-planner.json`. The standalone planner path remains unchanged when integration is absent.

- **Phase 1's actual exit gate is not demonstrated.** `Plan/Architect/_FINAL.md` §3:
  *"3 planuri consumer project reale trec linterul și rulează pe worker-ul existent."*
  `propose`/`inspect`/`compile` exist and their own unit tests pass, but nobody has
  run `propose` against 3 real consumer project task prompts, fed the results through
  `inspect`/`compile`, and confirmed the resulting `Plan/<id>.md` files actually run
  cleanly on `ai-code-worker`. This is real, uncompleted work — the code compiling
  and its own tests passing is not the same claim as the product's own exit gate
  being met. Needs 3 real prompts selected from consumer project work (same selection
  question already open at `Plan/Architect/_FINAL.md` §8 item 4) and real Claude
  usage to run `propose` 3 times for real (not against a fake CLI). Blocked on
  weekly usage budget as of 2026-08-16 — same constraint that shaped how Phase 1
  itself was built (claude-only, no independent review).
- `.ai-code-control/config/memory-control.json`'s narrow `include` list (see above)
  now also misses `docs/PHASE-1.md` and this file's own updates — same gap, not
  re-opened as a separate item.
## Resolved / observed in the EuroCarScan pilot (2026-09-05)

- **The planner was hard-coded to Claude and allowed an implicit model. FIXED.**
  The `codex`/`claude` registry now requires provider, model, reasoning effort,
  selection reason, and estimated cost cap; it has no automatic fallback.
  Provenance separates requested/resolved models and estimated/actual cost.
- **The first real Codex call was rejected by Structured Outputs. FIXED.** The
  output schema now declares `additionalProperties: false` at every object and
  the planner schema remains the final contract authority.
- **Operational observation:** an external launcher that kills Node before the
  adapter timeout can leave its Codex child process active. The pilot process
  was identified by PID/timestamp and stopped. Add a process-tree cancellation
  integration test before declaring the adapter production-hardened.
