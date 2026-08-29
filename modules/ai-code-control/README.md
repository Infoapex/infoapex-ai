# AI Code Control

Toolkit de memorie persistentă și disciplină de cod pentru agenți AI de programare
(Claude Code, Codex, orice client MCP). Îl adaugi într-un repository și agentul primește:

- **Memorie persistentă** — fișierele Markdown versionate în git sunt sursa canonică
  (ADR-uri, rezumate de task-uri, starea proiectului); un index SQLite FTS5 le face
  căutabile. Căutarea este insensibilă la diacritice și ordonată BM25.
- **Graf de cod** — simboluri, referințe și muchii în `codegraph.sqlite`, interogabile prin
  `find-symbol` / `impact-analysis` tranzitiv. C# folosește arbori sintactici Roslyn;
  TypeScript/JavaScript și SQL folosesc parsere syntax-aware; toate trei sunt incrementale.
  Indexerele de compatibilitate pentru Python și Rust rămân disponibile.
- **Trace graph temporal** — ADR-uri, contracte, task-uri, gates și evidence declarate,
  interogabile bounded prin `trace`, `why`, `affected`, `current` și
  `evidence-for`. T2 este exclus implicit, iar fiecare muchie păstrează provenance.
- **Refactor guard** — un plan per task declară branch-ul, owner-ul și scope-ul de
  fișiere/glob-uri; `verify-changed-files` blochează modificările din afara scope-ului și
  raportează suprapunerile cu task-urile active.
- **Runner de validare** — toolchain-uri generice, configurabile (dotnet, node, python,
  rust, orice), cu timeout per comandă și output capturat la eșec.
- **Server MCP** — toate comenzile expuse ca tool-uri peste stdio pentru Claude Code și
  alți clienți MCP.

Totul vorbește JSON pe stdout cu exit code-uri deterministe: `0` = succes, `1` =
eroare de utilizare/configurare, `2` = verificare picată.

## Pornire rapidă (proiect nou)

```bash
# 1. Copiază sau adaugă ca submodule acest repo în <repo-ul-tau>/tools/ai-code-control

# 2. Generează configurațiile de start (nu suprascrie niciodată fișiere existente)
dotnet run --project tools/ai-code-control/src/AiCodeControl.Cli -- init --template dotnet-nextjs
#    template-uri: dotnet-nextjs | python-rust | generic

# 3. Ajustează .ai-code-control/config/*.json, apoi reconstruiește ambele cache-uri
dotnet run --project tools/ai-code-control/src/AiCodeControl.Cli -- refresh --full

# 4. Compilează serverul MCP. Publish-ul CLI-ului este o optimizare opțională de pornire;
#    serverul MCP revine la `dotnet run` când nu există output publicat.
cd tools/ai-code-control/mcp-server && npm ci && npm run build

# 5. (opțional) Instalează guard-ul de scope pe pre-commit
./tools/ai-code-control/install-hook.ps1
```

Conectarea la Claude Code / Claude Desktop / alți clienți MCP: [tools/ai-code-control/CONNECT.md](tools/ai-code-control/CONNECT.md)
Contractul CLI (comenzi, formate JSON, exit code-uri): [CLAUDE.md](CLAUDE.md)

Contractul determinist pentru contextul compilat al agentului este documentat in
[docs/CONTEXT-PACKAGE-V1.md](docs/CONTEXT-PACKAGE-V1.md). Implementarea curenta
defineste schema, validarea si digestul semantic; integrarea in prompt ramane separata
si va fi activata gradual prin modurile `off`, `observe` si `enforce`.

Contractul intern pentru cache-ul temporal de trasabilitate este documentat in
[docs/TRACE-GRAPH-V1.md](docs/TRACE-GRAPH-V1.md). Graful pastreaza nodurile si muchiile
de trace separat de graful structural de cod; ingestia si query-urile publice sunt
activate gradual in etapele Graph Engineering urmatoare. Ingestia determinista accepta
numai documente declarate si relatii conforme cu
[contracts/trace-relations.v1.schema.json](contracts/trace-relations.v1.schema.json).

## Formula memoriei

| Comandă | Ce îi oferă agentului |
|---------|-----------------------|
| `memory-brief` | Context: decizii, task-uri anterioare, constrângeri (fără argument de task = brief pe memoria recentă, ideal pentru hook-uri de SessionStart) |
| `impact-analysis` | Adevărul codului: raza de impact tranzitivă și fișierele afectate |
| `trace` / `why` / `affected` / `current` / `evidence-for` | Relații declarate multi-hop, cu evidence, freshness și bugete stricte; fără fallback tăcut |
| `graph-drift` | Enforcement determinist pentru integritate, freshness, coverage, expected fixtures și projection drift |
| `trace-ingest` | Ingest declarat și determinist pentru sursele trace; suportă dry-run și refuză path traversal |
| `run-validation` | Adevărul funcționalității: build, lint, teste |
| `git diff` | Adevărul modificării: ce s-a schimbat efectiv |

Memoria nu este tratată niciodată drept adevăr despre cod (vezi ADR-0004). Markdown-ul
este canonic; indexul SQLite este derivat și poate fi oricând reconstruit cu
`memory-ingest` (ADR-0006).

## Code map pentru Obsidian

`ai-code-control` poate exporta proiecții Markdown separate pentru graful de cod și graful tipizat de trasabilitate. Exportul este opțional, atomic și read-only față de sursele canonice; plannerul și workerul nu depind de vault.

```bash
dotnet run --project tools/ai-code-control/src/AiCodeControl.Cli -- refresh --full
dotnet run --project tools/ai-code-control/src/AiCodeControl.Cli -- obsidian-export
```

Output-ul implicit este `docs/code-map/generated/` și este ignorat de Git. Pentru un vault extern sau pentru un snapshot limitat:

```bash
dotnet run --project tools/ai-code-control/src/AiCodeControl.Cli -- obsidian-export \
  --path modules/ai-code-worker \
  --out C:/vaults/infoapex-code-map \
  --include-symbols \
  --max-symbols 250
```

Exporterul produce `index.md` și `canvases/code-map.canvas` pentru cod, plus `trace-index.md`, note tipizate, `canvases/trace-map.canvas` și `.trace-projection-manifest.json` pentru trasabilitate. Implicit sunt incluse doar entitățile curente T0/T1; `--include-advisory` și `--include-superseded` sunt opt-in. Regenerarea prin staging + swap elimină fișierele stale. Nu se exportă transcripturi brute, secrete sau baza SQLite.

Contractul proiecției de trace și gate-ul de freshness sunt în [docs/OBSIDIAN-TRACE-PROJECTION-V1.md](docs/OBSIDIAN-TRACE-PROJECTION-V1.md).

## Workflow-ul agentului per task

```
memory-brief "<task>"          # context înainte de a atinge orice
find-symbol / impact-analysis  # localizare + raza de impact
<implementare>
verify-changed-files           # disciplina de scope vs current-plan.json
run-validation                 # toolchain-urile sunt verzi?
memory-add-task-summary --title "<task>" --from-current-git-diff
refresh                        # ingerează rezumatul + actualizează incremental graful de cod
```

## Structura repository-ului

```
.ai-code-control/
  config/code-control.json     # toolchain-uri, git guard, indexare
  config/memory-control.json   # include/exclude pentru memorie, setări de brief
  memory/                      # CANONIC: project-memory, decizii, reguli, rezumate
  tasks/                       # manifestele task-urilor active, folosite la detecția suprapunerilor
  db/                          # DERIVAT, gitignored: codegraph.sqlite, memory.sqlite
  reports/refactor/current-plan.json
tools/ai-code-control/
  src/                         # CLI + Core + Memory + indexere incrementale + RefactorGuard (.NET 9)
  tests/                       # suita de teste xUnit
  mcp-server/                  # wrapper MCP stdio (TypeScript)
  install-hook.ps1             # guard de scope pe git pre-commit
```

## Dezvoltare

```bash
cd tools/ai-code-control
dotnet build AiCodeControl.sln
dotnet test AiCodeControl.sln
```

CI rulează build + teste + compilarea MCP la fiecare push (vezi .github/workflows/ci.yml).

## Roadmap rămas

Vezi [PLAN-IMPLEMENTARE-AI-CODE-CONTROL.md](PLAN-IMPLEMENTARE-AI-CODE-CONTROL.md).
Graful actual este util în producție, dar nu este o bază de date semantică la nivel de
compilator: upgrade-urile viitoare pot adăuga semantică de compilare Roslyn, rezoluție de
simboluri cu compilatorul TypeScript și relații validate OpenAPI/scheme de evenimente.
Stocarea conversațiilor brute rămâne dezactivată intenționat; rezumatele revizuite sunt
mecanismul de memorie durabilă.
