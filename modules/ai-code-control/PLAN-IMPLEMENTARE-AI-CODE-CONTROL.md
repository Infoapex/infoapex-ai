# ai-code-control - Plan de implementare v1

> **Actualizare 2026-07-23:** fundația scalabilă este implementată. `index-code`
> indexează incremental C# prin Roslyn și TypeScript/JavaScript/SQL prin parsere
> syntax-aware, elimină fișierele șterse și înregistrează branch/commit. Analiza de
> impact este tranzitivă și refuză numele ambigue. Memoria verifică surse schimbate,
> neindexate, orfane și canonice lipsă, iar brief-ul respectă bugetul de tokeni.
> Manifestele active au branch/owner/scope și detectează suprapunerile. Codex și
> Claude folosesc aceleași fișiere canonice și același MCP. Unde secțiunile istorice
> descriu aceste funcții ca „viitoare”, această actualizare prevalează.

> **Documentul master** pentru transformarea ai-code-control in agentul de memorie si control al proiectelor Infoapex si in template refolosibil pentru orice proiect viitor.
> Scris pe 2026-07-04, pe baza auditului complet al codului existent (toate fisierele citite, buguri verificate empiric).
> Repo tinta pentru template: modules/ai-code-control

---

## 0. Decizii fixate (2026-07-04)

| Decizie | Alegere |
|---|---|
| Strategie | **Custom complet, incremental** - se construieste pe baza existenta, nu se adopta tool-uri terte ca solutie principala |
| Arhivarea conversatiilor | **Dezactivată** - transcripturile brute nu se persistă; rezumatele Markdown revizuite rămân memoria canonică. O arhivă separată ar necesita o decizie de securitate ulterioară. |
| Timebox pre-consumer project | **Max 2 saptamani** (Sprint 1). Ce nu incape se muta in Etapa 2/3. La expirare, Faza 0 consumer project porneste neconditionat |
| Integrare in platforma (viitor) | **Ambele, post-lansare**: agent-dezvoltator (modifica codul, propune PR/deploy) + agent-operator (operatii de business prin API admin cu RBAC). Acum se pregateste doar contractul curat |
| Amendament 2026-07-05 (a) | **Zero referinte la proiecte anterioare** - template complet general pentru orice proiect viitor |
| Amendament 2026-07-05 (b) | **Fara diacritice in fisierele template-ului** - cod, docs si config in engleza/ASCII, ca sa nu apara probleme de encoding. Exceptie utila: indexul FTS foloseste `remove_diacritics=2`, care face cautarea insensibila la diacritice in continutul scris de utilizatori |

---

## 1. Obiective

- **(A) Dev-time**: agent local cu cunostinte complete si mereu actualizate despre proiect - mapare codebase (simboluri, referinte, blast radius), memorie de decizii/task-uri/etape, arhiva cautabila a conversatiilor - astfel incat asistentii AI sa nu mai consume tokeni pe re-research la fiecare prompt.
- **(B) Template**: totul refolosibil pe orice proiect viitor printr-o comanda `init`, publicat pe `Infoapex/ai-code-control`.
- **(C) Runtime** (post-lansare consumer project): agentul integrat in platforma ecommerce (dev-agent + operator-agent).

---

## 2. Starea actuala - concluziile auditului (2026-07-04)

**Refolosibil direct (~40-50%)**: schema `codegraph.sqlite` agnostica de limbaj (`files`/`symbols`/`references_map`/`edges` cu coloana `language`); memoria Markdown-canonic + index FTS5 cu ingest idempotent pe SHA256; `RefactorGuardService` (100% agnostic de limbaj, merge azi pe C#+TS); contractul CLI JSON + exit codes 0/1/2; wrapper-ul MCP subtire; `install-hook.ps1`; practica ADR-urilor.

**Buguri blocante confirmate** (detalii in §4, Etapa 0):

| # | Bug | Fisier | Efect |
|---|---|---|---|
| 1 | Deadlock pe pipe-uri: stdout redirectat dar necitit | `Core/Services/CommandRunner.cs` | fals-timeout garantat pe `dotnet build`/`next build` |
| 2 | Glob `**/` nefunctional (`Regex.Escape` nu escapeaza `/`) | `Memory/Services/GlobResolver.cs:44` | `project-memory.md` nu se ingereaza; excluderea secretelor nu se aplica |
| 3 | Parsarea `--symbol`/`--query` moarta (ia literal "--symbol" ca query) | `Cli/Program.cs` | forma cu optiune inutilizabila la find-symbol/impact-analysis/memory-* |
| 4 | Fallback `REPO_ROOT` gresit cu un nivel (`../../..` -> `<repo>/tools`) | `mcp-server/src/server.ts:14` | serverul MCP merge doar cu env var setat explicit |
| 5 | Sln rupt: refera `tests/AiCodeControl.Tests` inexistent (MSB3202) | `AiCodeControl.sln` | `dotnet build` pe solutie esueaza |

**Alte lipsuri majore**: zero teste; indexere doar Python/Rust pe regex (contrazic ADR-0001/0002 - nu se extind, se inlocuiesc unde e nevoie); 6 din 15 comenzi CLI lipsesc din MCP (critic: indexarea); config partial ignorat de cod (`indexing.database`, `indexing.exclude`, `sourcePaths`, `logging` - nedeserializate); erori CLI = stack trace brut; cautarea FTS face AND strict pe toate cuvintele (brief-ul cu descriere de task returneaza aproape sigur 0 rezultate); brief-ul afiseaza doar titluri, fara snippets; hardcodari din proiectul-gazda anterior (config, CONNECT.md, template task-summary, "Required next commands").

---

## 3. Arhitectura tinta

```
<proiect-tinta>/                          # ex. consumer project/
├── .ai-code-control/
│   ├── config/
│   │   ├── code-control.json             # toolchains GENERICE (dotnet, node, python, rust...)
│   │   └── memory-control.json           # include/exclude, conversatii (nou)
│   ├── memory/                           # CANONIC, versionat in git
│   │   ├── project-memory.md
│   │   ├── decisions/ADR-*.md
│   │   ├── tasks/*.md
│   │   └── summaries/*.md
│   ├── db/                               # DERIVAT, in .gitignore
│   │   ├── codegraph.sqlite              # simboluri C#/TS/SQL/... (code truth)
│   │   ├── memory.sqlite                 # index FTS al markdown-ului
│   │   └── conversations.sqlite          # NOU: transcripturi redactate (istoric cautabil)
│   └── reports/refactor/current-plan.json
├── .mcp.json                             # conectare Claude Code (conventia corecta)
└── .claude/settings.json                 # hooks: SessionStart brief, PostToolUse guard

tools/ai-code-control/                    # tool-ul (submodul/copie din repo template)
├── src/
│   ├── AiCodeControl.Cli                 # dispatch + JSON out + exit codes
│   ├── AiCodeControl.Core                # storage, config, validation, query
│   ├── AiCodeControl.Memory              # ingest/search/brief/task-summary
│   ├── AiCodeControl.Conversations       # NOU (Sprint 1 stretch / Etapa 3)
│   ├── AiCodeControl.CSharpIndexer       # NOU (Etapa 2) - Roslyn
│   ├── AiCodeControl.TypeScriptIndexer   # NOU (Etapa 3) - ts-morph prin proces Node
│   ├── AiCodeControl.SqlIndexer          # NOU (Etapa 3) - migratii EF + pg_proc
│   ├── AiCodeControl.PythonIndexer       # existent (se pastreaza in template)
│   ├── AiCodeControl.RustIndexer         # existent (se pastreaza in template)
│   └── AiCodeControl.RefactorGuard       # existent (se extinde cu prefixe node)
├── tests/AiCodeControl.Tests             # NOU - obligatoriu din Etapa 0
└── mcp-server/                           # wrapper MCP peste CLI
```

**Formula de adevar ramane cea din ADR-0004** (corecta, se pastreaza):
`memory-brief` = context (ce am decis) - `impact-analysis` = code truth (ce se strica) - `run-validation` = functionality truth - `git diff` = modification truth. Nou: `conversations-search` = istoric (ce s-a discutat) - **context, nu fapte despre cod**.

---

## 4. Sprint 1 - max 2 saptamani, inainte de Faza 0 consumer project

### Etapa 0 - Reparatii fundatie (zile 1-3)

> ✅ **FINALIZATA 2026-07-05.** Toate cele 7 puncte implementate; proiect de teste creat (22 teste verzi: glob, command runner, ingest idempotent + secrete, search); sln reparat; MCP compileaza. Bonus fata de plan: drain stderr si in helper-ele git din RefactorGuardService/MemoryTaskSummaryService, PK pe `schema_version` (fara duplicate la re-init), `--limit` la memory-search, System.CommandLine (dependinta moarta) eliminat.

1. **Fix CommandRunner** (`Core/Services/CommandRunner.cs`): citire concurenta stdout+stderr (`ReadToEndAsync` pornit inainte de `WaitForExitAsync`), captura stdout in rezultat (agentul trebuie sa vada *de ce* pica un test), pastreaza timeout + `Kill(true)`.
2. **Fix GlobResolver** (`Memory/Services/GlobResolver.cs`): tratarea corecta a `**/` (fix ~5 linii) + oprirea traversarii recursive in directoare excluse (node_modules, .git) - altfel ingest-ul pe monorepo devine lent.
3. **Fix parsare argumente CLI** (`Cli/Program.cs`): optiunile `--symbol`/`--query` functionale; alternativ, se foloseste efectiv System.CommandLine (deja referentiat) sau se scoate dependenta moarta.
4. **Fix REPO_ROOT** (`mcp-server/src/server.ts:14`): `../../../..`; plus `isError: true` la esec CLI si timeout pe `execa`.
5. **Reparare sln**: creare proiect `tests/AiCodeControl.Tests` (xUnit) cu teste pe exact zonele reparate: GlobResolver (matrice de pattern-uri), CommandRunner (comanda verbose nu da timeout), ParsePorcelain, ingest idempotent, BuildFtsQuery.
6. **Error handling la marginea CLI**: handler global in `Program.cs` - orice exceptie -> JSON `{ "status": "error", "message": ... }` + exit 1; `memory-ingest` fara `memory-init` -> eroare clara (azi: exit 0 cu "partial").
7. **Config citit real**: deserializare completa `code-control.json` (`indexing.database`, `indexing.exclude`, `sourcePaths`) si eliminarea caii DB hardcodate din `Program.cs:10`.

**DoD Etapa 0**: `dotnet build` pe sln trece; `dotnet test` verde; `run-validation` pe un proiect .NET demo cu output verbose se incheie corect cu stdout capturat.

### Etapa 1 - Memorie operationala pe consumer project + template curat (zile 4-10)

> ✅ **FINALIZATA 2026-07-05, extinsă 2026-07-23.** Pe lângă fundația inițială,
> sunt implementate indexarea C#/TS/JS/SQL, reindexarea incrementală, health-check-ul
> de memorie, impactul tranzitiv, manifestele paralele și integrarea comună
> Codex/Claude. Arhiva conversațiilor rămâne intenționat dezactivată; se persistă
> rezumate revizuite.

8. **Toolchains generice in ValidationRunner**: inlocuirea claselor `PythonConfig`/`RustConfig` cu lista generica `toolchains: [{ name, workingDir, commands: {...}, timeouts }]`; profiluri `dotnet` (restore/build/format --verify-no-changes/test) si `node` (pnpm lint, tsc --noEmit, test, build). Fix escaping shell.
9. **Cautare FTS utilizabila**: tokenizer `unicode61 remove_diacritics=2` (esential pentru romana), OR + rank BM25 in loc de AND strict, extragere de cuvinte-cheie din descrierea task-ului la `memory-brief`, comanda `memory-prune` pentru intrari orfane.
10. **Brief cu continut**: `MemoryBriefService` include snippets (exista deja in `MemorySearchService`, azi se arunca), primele linii din ADR-urile relevante, iar sectiunea "Required next commands" devine configurabila (azi hardcodata pe layout-ul vechi).
11. **RefactorGuard pentru monorepo C#+TS**: `DefaultGeneratedPrefixes` extins cu `node_modules/`, `.next/`, `dist/`, `coverage/`, `.turbo/`; exemplu `current-plan.json` pentru un task C#/TS.
12. **MCP complet si corect**: expune toate comenzile relevante (inclusiv indexare si refactor-guard - azi 6/15 lipsesc); documentatie pe `.mcp.json` (nu `claude.json` - instructiunea actuala nu functioneaza); curatare `zod` nefolosit sau folosire reala la validare.
13. **Hooks Claude Code** (`.claude/settings.json` in proiectul tinta): `SessionStart` -> ruleaza `memory-brief` si injecteaza rezultatul; `Stop`/sfarsit de task -> reminder `memory-add-task-summary` + `memory-ingest`; optional `PreToolUse` pe Edit/Write -> `verify-changed-files` (feedback la editare, nu doar la commit). Inchide bucla din ADR-0005 tehnic, nu doar prin conventie.
14. **`init --template dotnet-nextjs`**: genereaza `code-control.json` + `memory-control.json` + `current-plan.json` gol + `.mcp.json` + schelet `memory/` pentru un monorepo C#+TS. Varianta `--template python-rust` pastreaza comportamentul vechi.
15. **De-hardcodare completa (template)**: eliminarea cailor spre proiectul anterior din CONNECT.md, config inlocuit cu exemple per template, template-ul task-summary parametrizat pe toolchains (nu ruff/cargo hardcodat), titlul README actualizat (nu mai e "Python + Rust").
16. **CLAUDE.md de contract**: documenteaza fiecare comanda (input, output JSON, exit codes) ca agentii sa foloseasca CLI-ul corect fara ghicit.
17. **CI GitHub Actions + publicare**: build + test + dogfooding (`verify-changed-files` pe el insusi); push in `Infoapex/ai-code-control` cu istoric curat.

**DoD Etapa 1**: pe un clone proaspat - `init --template dotnet-nextjs` -> `memory-init` -> `memory-ingest` -> `memory-brief "task de test"` returneaza context relevant cu snippets; MCP conectat in Claude Code prin `.mcp.json` cu toate tool-urile functionale; repo-ul GitHub contine template-ul curat cu CI verde.

### Stretch (doar daca ramane timp in cele 2 saptamani)

18. **Ingestie conversatii (hibrid - decizia fixata)**: proiect `AiCodeControl.Conversations` - citeste transcripturile Claude Code din `~/.claude/projects/<slug>/*.jsonl`, extrage mesajele user/assistant (fara tool results voluminoase), **redacteaza secrete** (regex pe pattern-uri de chei/parole/token-uri + exclude-urile din config), scrie in `conversations.sqlite` (FTS5, tabel separat de memoria canonica) cu retentie configurabila. Comenzi: `conversations-ingest`, `conversations-search`. **ADR-0007 nou**: transcripturile = istoric cautabil ("ce s-a discutat"), NU memorie canonica; amendeaza ADR-0006 pastrandu-i argumentul (rezumatele raman sursa de adevar).

**Regula de garda Sprint 1**: la finalul zilei 10 de lucru, orice item neterminat se muta in Etapa 2/3 si **Faza 0 consumer project porneste**. Zero hardcodari noi - orice cale/comanda noua intra in config, altfel template-ul (B) moare.

---

## 5. Etapa 2 - Code truth pentru C# (in timpul Fazelor 1-2 consumer project)

Se construieste **abia cand exista cod C# real** de indexat si validat contra lui (Domain/Application/Infrastructure).

1. **`AiCodeControl.CSharpIndexer` pe Roslyn** (4-6 zile): `Microsoft.CodeAnalysis` + `MSBuildWorkspace` pe `Example.sln` - simboluri cu span real (StartLine/EndLine), accesibilitate reala, referinte **semantice** (`SymbolFinder.FindReferencesAsync` - elimina rezolvarea naiva pe nume unic din indexerele regex). Scrie in schema existenta fara migrare. Tabel auxiliar `csharp_project_refs` (csproj -> ProjectReference/PackageReference) pentru graful monolitului modular.
2. **Reindexare incrementala** (1,5-2 zile): comparare hash SHA256 (exista in tabela `files`, azi necomparat), comanda `index-changed --since <ref>`, hook git post-commit + hook Claude Code `PostToolUse` pe Edit/Write care reindexeaza fisierul atins. **Fara asta graful devine stale si mincinos - obiectivul "mereu actualizat" depinde de acest pas.**
3. `impact-analysis` imbunatatit: traversare tranzitiva pe `edges` (azi doar 1 nivel), risc care tine cont de tipul simbolului.

**DoD**: pe codebase-ul Example real, `find-symbol OrderService` si `impact-analysis` returneaza referinte corecte semantice; dupa un edit, graful se actualizeaza automat.

## 6. Etapa 3 - Extindere (pe parcursul Fazelor 2-4 consumer project)

1. **Indexer TypeScript** (4-6 zile, risc mai mare - teren nou): script Node pe ts-morph care emite JSON (componente, hooks, route handlers, server actions, importuri) + serviciu .NET care persista in SQLite; tabel `ts_imports` pentru rezolvare cross-file. *Regula: daca in practica Grep + Explore acopera frontend-ul suficient, acest item se amana indefinit - valoarea grafului e cea mai mare pe C#, unde e logica de business.*
2. **Indexer SQL/Postgres** (2-3 zile): parsare migratii EF + fisiere `.sql` + optional introspectie live pe DB-ul de dev (`pg_proc`, `information_schema`) -> `symbols` cu `language='sql'`. Acopera cerinta explicita "proceduri stocate". Lightweight - pe stack EF Core-first vor fi putine.
3. **`context-pack`** (1-2 zile): comanda agregata = memory-brief + find-symbol + impact-analysis + snippets + conversations-search intr-un singur brief injectabil - **diferentiatorul real anti-re-research**, rulat automat de hook-ul SessionStart.
4. **Ingestie conversatii** - daca nu a incaput in Sprint 1.

## 7. Post-lansare consumer project - obiectivul (C): agentul in platforma

**Nu se construieste nimic acum** (YAGNI, decizie asumata). Directia, pentru care pastram contractul curat:

- **Agent-dezvoltator**: serviciu (Claude Agent SDK) care impacheteaza acelasi CLI - primeste cereri din consola admin, lucreaza pe un clone al repo-ului intr-un sandbox, foloseste memory-brief/impact-analysis/refactor-guard, produce PR + validari, deploy doar cu aprobare umana.
- **Agent-operator**: chatbot in admin care executa operatii de business prin API-ul `/api/v1/admin/*` existent, cu permisiunile RBAC ale utilizatorului conectat (agentul nu primeste drepturi proprii) si audit_log pe fiecare actiune.
- **Pregatirea de azi** (cost ~0): CLI-ul ramane stateless, JSON in/out, exit codes semantice, fara interactiune - exact ce poate impacheta un serviciu HTTP mai tarziu. Estimare separata post-lansare: 3-4 saptamani pentru varianta sigura (RBAC + sandbox + audit).

## 8. Ce NU construim (decizii anti-scope-creep)

- Cautare vectoriala/semantica - FTS5 cu OR + diacritice e suficient la scara asta; ADR-0004 ramane valid. Reevaluare doar daca cautarea doare masurabil.
- Daemon/cache pentru MCP - spawn per apel e acceptabil la volum de dev solo.
- Rescrierea indexerelor Python/Rust - raman in template ca atare (nu le folosim pe Example, nu costa nimic).
- tree-sitter, rust-analyzer, orchestrare multi-repo, UI propriu.

## 9. Riscuri

| # | Risc | Mitigare |
|---|---|---|
| 1 | Tool-building procrastination - agentul consuma timpul consumer project | Timebox dur 2 saptamani + regula de garda din §4; Etapele 2-3 doar in paralel cu Example, nu inaintea lui |
| 2 | Indexerul TS scapa de sub control (barrel exports, RSC, generics) | E ultimul in coada si are clauza explicita de abandon (§6.1) |
| 3 | Graful devine stale -> agentul primeste informatii false | Reindexarea incrementala e parte din DoD Etapa 2, nu optionala; hash-check exista deja in schema |
| 4 | Secrete in arhiva de conversatii | Redactare la ingest + exclude patterns + `conversations.sqlite` in .gitignore + retentie; rezumatele canonice raman curate |
| 5 | Template-ul diverge de instanta Example | Tool-ul se dezvolta DOAR in repo-ul template; proiectele il consuma ca submodul/copie versionata - fix-urile curg intr-o singura directie |

## 10. ADR-uri noi de scris pe parcurs

- **ADR-0007**: Arhivare hibrida a conversatiilor (index separat redactat + rezumate canonice) - amendeaza ADR-0006.
- **ADR-0008**: Indexer C# pe Roslyn cu referinte semantice (inlocuieste abordarea regex; aliniat cu spiritul ADR-0001).
- **ADR-0009**: Toolchains generice config-driven in ValidationRunner (inlocuieste PythonConfig/RustConfig hardcodate).
- **ADR-0010**: Hooks Claude Code ca enforcement tehnic al workflow-ului din ADR-0005.

---

> **Documentul e viu.** Actualizeaza-l la fiecare item terminat (bifeaza), la fiecare decizie noua (ADR + rand in §0) si la orice taiere de scope (muta itemul in §8 cu motivul).
