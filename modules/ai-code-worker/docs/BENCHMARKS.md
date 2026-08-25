# Token & usage benchmarks — Phase 3

Acest fișier este jurnalul de checkpoint-uri pentru consumul de tokeni în timpul implementării Phase 3 (Claude Code). Scopul lui nu e un număr absolut de tokeni, ci **procentul consumat din fereastra rulantă de 5 ore și din limita săptămânală** a abonamentului, per etapă/subetapă — ca să putem extrapola pe viitor cât "costă" o etapă similară înainte de a o începe.

## Protocol

La fiecare checkpoint (start și end de etapă), userul rulează în interfața Claude Code două comenzi și raportează rezultatul:

- **`/usage`** (sau panoul "Account & Usage") → `%5h` (Session 5hr) și `%săpt` (Weekly 7 day). Aceasta e sursa de adevăr — metrica chiar bugetată de Anthropic.
- **`/context`** → contextul curent în tokeni, pe categorii. Reținem în special:
  - **Context total** (ex. `437.0k / 967.0k tokens (45%)`) — mărimea totală a contextului activ.
  - **Messages** — partea din context care crește efectiv cu munca din conversație (fișiere citite, tool output, răspunsuri). Restul categoriilor (system prompt, system tools, custom agents, memory files, skills) sunt overhead relativ fix, care nu variază per etapă.

Pași:
1. **Start etapă**: se înregistrează `%5h`, `%săpt`, Context total și Messages ca rând `start`.
2. **End etapă**: aceleași patru valori, rând `end`.
3. **Delta** (`end − start`) pe fiecare coloană = costul real al etapei, trecut în tabelul rezumat.
4. Datele sunt auto-raportate de user prin `/usage` și `/context` — nu există tool programatic prin care agentul să le citească direct (vezi secțiunea de mai jos).

**Avertisment metodologic — Messages ≠ suma tokenilor facturați pe sesiune.** `/context` arată dimensiunea *curentă* a contextului, nu un contor cumulativ al tokenilor plătiți turn-cu-turn (fiecare tur re-trimite tot contextul, deci tokenii facturați cumulat pe sesiune sunt mai mari decât snapshot-ul final). E totuși cel mai bun proxy disponibil pentru delta *între* checkpoint-uri în aceeași sesiune. Dacă intervine autocompact între două checkpoint-uri, Context total poate scădea brusc (rescriere/sumarizare) — o astfel de citire nu mai e comparabilă direct și trebuie notată separat, nu inclusă în delta normală.

## Jurnal checkpoint-uri

| # | Tip | Etapă / subetapă | Data/ora | %5h | %săpt | Context total | Messages | Notă |
|---|-----|-------------------|----------|-----|-------|----------------|----------|------|
| 1 | start | 1. Data model & schemas | 2026-08-14 (sesiune 5h resetează în 3h56min de la momentul raportării) | 28% | 3% | — | — | Baseline; /context nu era încă descoperit ca metodă |
| 2 | end | 1. Data model & schemas | 2026-08-14 (sesiune 5h resetează în 3h45min de la momentul raportării) | 35% | 4% | — | — | 8 schemas JSON noi + tipuri TS + fixtures + teste; 169/169 teste, phase0/phase2 demo PASS; 2 commit-uri (fix testedVersionRanges + data model Phase 3) |
| 3 | start | 2. Review finding ingestion (fixtures) | 2026-08-14 (sesiune 5h resetează în 3h45min de la momentul raportării) | 35% | 4% | — | — | Neschimbat față de finalul Etapei 1 |
| 4 | end | 2. Review finding ingestion (fixtures) | 2026-08-14 (sesiune 5h resetează în 3h37min de la momentul raportării) | 38% | 4% | — | — | 2 module + 5 fixtures + 5 teste; 174/174 teste; 1 commit, +274 inserții |
| 5 | start | 3. Repair task compiler | 2026-08-14 (sesiune 5h resetează în 3h de la momentul raportării) | 39% | 4% | 437.0k / 967.0k (45%) | 396.2k | Prima citire /context — metodă confirmată de user; overhead fix: system prompt 9.9k, system tools 23.0k, custom agents 2.8k, memory 1.3k, skills 3.8k, autocompact buffer 33.0k |
| 6 | end | 3. Repair task compiler | 2026-08-14, resetează Aug 15 2:10am (Europe/Bucharest) | 43% | 5% | 489.8k / 967k (51%) | 449.7k | 1 modul (compile-repair-tasks.ts, union-find pe scope) + 5 teste; 179/179 teste; 1 commit, +283 inserții. Prima pereche start/end cu tokeni reali: Δ Context +52.8k, Δ Messages +53.5k pentru Δ%5h +4pp → ~13.2-13.4k tokeni/punct procentual 5h |
| 7 | start | 4. Bounded repair cycles în state machine | 2026-08-14, resetează Aug 15 2:09am (Europe/Bucharest) | 44% | 5% | 506.1k / 967k (52%) | 465.7k | Cea mai riscantă etapă — atinge state machine existent (fake-run.ts/claude-run.ts/codex-run.ts) |
| 8 | end | 4. Bounded repair cycles în state machine | 2026-08-14, resetează Aug 15 2:09am (Europe/Bucharest) | 48% | 5% | 552.9k / 967k (57%) | 512.5k | 1 modul (repair-cycle.ts, buclă REPAIRING) + 5 teste + todo.md; 184/184 teste, phase0/phase2 demo PASS, zero regresii (nu am atins fake-run/claude-run/codex-run — integrare amânată explicit, vezi todo.md #6) |
| 9 | start | 5. Graph revision semantics | 2026-08-14, resetează Aug 15 2:09am (Europe/Bucharest) | 48% | 5% | 552.9k / 967k (57%) | 512.5k | = finalul Etapei 4 |
| 10 | end | 5. Graph revision semantics | 2026-08-14, resetează Aug 15 2:09am (Europe/Bucharest) | 51% | 6% | 581.1k / 967k (60%) | 540.7k | 1 modul (create-graph-revision.ts, verificare invarianți) + 6 teste; 190/190 teste; zero regresii |
| 11 | start | 6. Descendant invalidation | 2026-08-14, resetează Aug 15 2:09am (Europe/Bucharest) | 51% | 6% | 581.1k / 967k (60%) | 540.7k | = finalul Etapei 5 |
| 12 | end | 6. Descendant invalidation | 2026-08-14, resetează Aug 15 2:10am (Europe/Bucharest) | 53% | 6% | 604.2k / 967k (62%) | 563.8k | 1 modul (invalidate-descendants.ts, reutilizează descendantsOf + buildTaskInputSnapshot) + 4 teste; 194/194 teste; zero regresii — cea mai rapidă etapă, cum era anticipat |
| 13 | start | 7. Recovery tests (process kill) | 2026-08-14, resetează Aug 15 2:10am (Europe/Bucharest) | 53% | 6% | 604.2k / 967k (62%) | 563.8k | = finalul Etapei 6 |
| 14 | end | 7. Recovery tests (process kill) | 2026-08-14, resetează Aug 15 2:09am (Europe/Bucharest) | 58% | 6% | 663k / 967k (69%) | 622.6k | 2 teste noi + bug real găsit și fixat (worktree integrare, recreateIfExists) + todo.md #7/#8; 196/196 teste, phase0/phase2 demo PASS |
| 15 | start | 8. Export: patch/branch/report | 2026-08-14, resetează Aug 15 2:09am (Europe/Bucharest) | 58% | 6% | 663k / 967k (69%) | 622.6k | = finalul Etapei 7 |
| 16 | end | 8. Export: patch/branch/report | 2026-08-14, resetează Aug 15 2:10am (Europe/Bucharest) | 60% | 6% | 686.4k / 967k (71%) | 646.1k | 4 module export (patch/branch/blocked/repair-evidence) + 6 teste; 202/202 teste, zero regresii |
| 17 | start | 9. Security/redaction tests | 2026-08-14, resetează Aug 15 2:10am (Europe/Bucharest) | 60% | 6% | 686.4k / 967k (71%) | 646.1k | = finalul Etapei 8 |
| 18 | end | 9. Security/redaction tests | 2026-08-15, resetează Aug 15 2:09am (Europe/Bucharest) | 63% | 7% | — | — | /context neraportat de data asta; 3 module extinse/noi + 7 teste; 209/209 teste, phase0/phase2 demo PASS |
| 19 | end | 10. Pass cu adaptoare reale (bloc mare, bundle Etape 4/6/7/9 amânate) | 2026-08-15, resetează Aug 15 2:10am (Europe/Bucharest) | 76% | 8% | 834.8k / 967k (86%) | 794.4k | Cea mai mare etapă: wiring complet repair-loop în fake-run/claude-run/codex-run (3 fișiere), 3 module noi, 11 teste noi, bug fix RunEventType, validare reală doctor+run cu Claude (PASS, v2.1.177). Fără citire /context la începutul etapei — delta exactă nedisponibilă, dar Δ%5h +13pp / Δ%săpt +1pp pentru o etapă de ~3-4x mărimea unei etape obișnuite |

## Rezumat consum per etapă

Completat progresiv, pe măsură ce avem perechi start/end pentru fiecare etapă din `HANDOFF-PHASE-3-CLAUDE.md` § Recommended sequencing.

| Etapă | Δ %5h | Δ %săpt | Δ tokeni (Context/Messages) | Observații |
|-------|-------|---------|------------------------------|------------|
| 1. Data model & schemas | +7pp | +1pp | — (fără /context la momentul respectiv) | 8 schemas noi + tipuri TS + fixtures/teste, fără logică de construcție (S/mic ca amploare, dar 8 obiecte de domeniu distincte) |
| 2. Review finding ingestion (fixtures) | +3pp | +0pp | — (fără /context la momentul respectiv) | 2 module (ingest-review, review-fixture) + 5 fixtures + 5 teste, proxy ~15 tool calls / 9 fișiere / +274 inserții |
| 3. Repair task compiler | +4pp | +1pp | +52.8k / +53.5k | 1 modul (compile-repair-tasks.ts) + 5 teste, +283 inserții. **Prima calibrare reală: ~13.2-13.4k tokeni per punct procentual din fereastra 5h** |
| 4. Bounded repair cycles în state machine | +4pp | +0pp | +46.8k / +46.8k | 1 modul (repair-cycle.ts) + 5 teste, +422 inserții — dar scope redus (nu s-a atins fake-run/claude-run/codex-run, integrare amânată la Etapa 10). ~11.7k tokeni/pp — a doua calibrare, apropiată de Etapa 3 |
| 5. Graph revision semantics | +3pp | +1pp | +28.2k / +28.2k | 1 modul (create-graph-revision.ts) + 6 teste, +333 inserții. ~9.4k tokeni/pp — a treia calibrare, ceva mai jos dar în același interval |
| 6. Descendant invalidation | +2pp | +0pp | +23.1k / +23.1k | 1 modul (invalidate-descendants.ts) + 4 teste, cel mai mic diff din Etape (reutilizare masivă de cod existent). ~11.55k tokeni/pp — a patra calibrare, în interval |
| 7. Recovery tests (process kill) | +5pp | +0pp | +58.8k / +58.8k | 2 teste + investigare/fix bug real (worktree integrare) + todo.md; ~11.76k tokeni/pp — a cincea calibrare, în interval, deși a inclus debugging nu doar scriere de cod |
| 8. Export: patch/branch/report | +2pp | +0pp | +23.4k / +23.4k | 4 module + 6 teste; ~11.7k tokeni/pp — a șasea calibrare, în interval |
| 9. Security/redaction tests | +3pp | +1pp | — (fără /context) | 3 module extinse/noi (redaction.ts, export-artifacts.ts +writeIndependentReviewReport) + 7 teste, inclusiv fail-closed pe patch-uri cu secrete |
| 10. Pass cu adaptoare reale | +13pp | +1pp | — (fără start /context) | Bloc mare bundle: wiring repair-loop în 3 runners + 3 module noi + 11 teste + validare reală Claude. ~3-4x o etapă obișnuită ca livrabil |

## De ce agentul nu poate citi singur aceste date

Confirmat 2026-08-14: agentul (Claude Code, în acest harness) nu are acces la niciun tool care să-i expună direct consumul propriu de tokeni sau procentul din fereastra 5h/limita săptămânală (verificat explicit — `ToolSearch` fără rezultat pentru "token usage cost count session"). Motivul e structural:

- **%5h și %săpt sunt calculate server-side**, de sistemul de rate-limiting al Anthropic, la nivel de cont — nu de client, și formula exactă de ponderare (input/output/cache, per model, per efort) nu e publică.
- **Contextul (`/context`) e o funcție a interfeței Claude Code**, nu a modelului însuși — modelul nu-și vede propriile metadate `usage` din conversație.

**Rezolvat 2026-08-14** — userul confirmă că interfața sa Claude Code expune ambele comenzi (`/context` și `/usage`/panoul "Account & Usage"). Metoda de lucru curentă:

1. La fiecare checkpoint, userul rulează `/context` și `/usage` (sau deschide panoul de cont) și raportează valorile.
2. Agentul le înregistrează în jurnalul de mai sus — nu le poate citi singur, dar odată furnizate, calculează delta și le păstrează ca referință reutilizabilă.
3. `%5h`/`%săpt` rămân referința primară (e metrica efectiv bugetată); Context total/Messages sunt proxy-ul în tokeni cerut explicit de user, cu avertismentul metodologic de mai sus (nu e un contor cumulativ de tokeni facturați, ci un snapshot de context).

## Cum se folosește pentru estimări viitoare

Odată ce avem cel puțin 2-3 etape cu date reale, un tabel de "cost mediu per etapă mică/medie/mare" (S/M/L, vezi clasificarea din discuția inițială) poate fi derivat prin interpolare — și folosit pentru a răspunde direct la întrebări de tipul "cât ar consuma subetapa X" fără o nouă rundă de estimare teoretică.

## Phase 4 / Part B — auto-tracked (2026-08-15+)

**Actualizare metodologică**: secțiunea de mai sus ("De ce agentul nu poate citi singur aceste date") rămâne corectă pentru %5h/%săpt — acele procente tot nu sunt expuse local, nicăieri. Dar tokenii de context **pot** fi citiți direct de agent: fișierul local de transcript al acestei sesiuni Claude Code
(`~/.claude/projects/<project-hash>/<session-id>.jsonl`) conține, pe fiecare linie `assistant`, un `message.usage` cu `input_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens`/`output_tokens` — exact formatul deja parsat de `src/benchmark/read-claude-session.ts` (Part A) pentru alte sesiuni. Pentru Part B, agentul își citește **propriul** fișier de sesiune la fiecare graniță de etapă, fără să ceară userului `/usage`/`/context` manual. Context curent ≈ ultimul `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, aceeași formulă ca la Phase 3. %5h/%săpt rămân derivate (nu măsurate) via calibrarea ~11.7k tokeni/pp de mai sus.

| # | Tip | Etapă | Timestamp (transcript) | Context (input+cache_read+cache_creation) | Δ tokeni | Notă |
|---|-----|-------|--------------------------|---------------------------------------------|----------|------|
| 1 | start | 1. Provider `ai-code-control` skeleton | 2026-08-14T23:55:56.633Z | 109,369 | — | Baseline pentru Part B |
| 2 | end | 1. Provider `ai-code-control` skeleton | 2026-08-15T00:04:26.274Z | 171,714 | **+62,345** | 5 scheme noi (`context-provider-*.schema.json`) + `src/context-provider/{types,none-provider,ai-code-control-cli,resolve}.ts` + câmp `contextProvider`/`adapters.aiCodeControl` în `ProjectConfig` + 12 teste noi (fake CLI via `process.execPath`); 268/268 teste, phase0/phase2 demo PASS. Neconectat încă în pipeline (asta e Etapa 2) — comportament identic confirmat. Sub estimarea inițială (70-95k) |
| 3 | start | 2. Wire health/brief/impact/scope/refresh | 2026-08-15T00:04:26.274Z | 171,714 | — | = finalul Etapei 1 |
| 4 | end | 2. Wire health/brief/impact/scope/refresh | 2026-08-15T00:10:26.735Z | 203,308 | **+31,594** | `cli.ts`: health+brief înainte de compile, refresh după DONE, toate la punctul unic de dispecerizare `run` (fără atingere fake-run/claude-run/codex-run); `contextProvider` apare în JSON doar când providerul e activ (altfel identic ca înainte). find-symbol/impact-analysis per-task (flow item 3) amânat deliberat — ai-code-worker nu are identificare de simboluri, ar fi fost o euristică fragilă inventată, nu ceri din spec; metodele rămân disponibile pe provider pentru un caller viitor. +2 teste CLI end-to-end; 270/270 teste, phase0/phase2 demo PASS. Sub estimarea inițială (60-80k) |
| 5 | start | 3. Export handoff redactat | 2026-08-15T00:10:26.735Z | 203,308 | — | = finalul Etapei 2 |
| 6 | end | 3. Export handoff redactat | 2026-08-15T00:15:07.849Z | 229,032 | **+25,724** | `writeRedactedHandoff()` în `export-artifacts.ts`, reutilizează `prepareReportText` (redactare+truncare) ca `writeBlockedReport`/`writeIndependentReviewReport`; scrie în `.ai-code-control/handoffs/<runId>.md`. Gate dublu explicit: `contextProvider !== "none"` ȘI `handoffExport: true` în config (câmp nou, default false) — "regula configurată" din spec. +4 teste (2 unitare redactare, 2 CLI end-to-end pentru gate). 274/274 teste, phase0/phase2 demo PASS. Cea mai reutilizată etapă până acum (aproape totul din redaction.ts era deja acolo), sub estimarea inițială (40-55k) |
| 7 | start | 4. `init`/`update` cu blocuri versionate | 2026-08-15T00:15:07.849Z | 229,032 | — | = finalul Etapei 3 |
| 8 | end | 4. `init`/`update` cu blocuri versionate | 2026-08-15T00:21:33.359Z | 248,620 | **+19,588** | `src/config/init.ts`: comenzi noi `ai-code-worker init`/`update`. `init` scrie `.ai-code-worker/config.json` (doar câmpurile chiar citite de `loadProjectConfig` azi — nu forma aspirațională completă din §6, ca să nu creeze config care pare autoritativ dar nu face nimic) + README.md; refuză să suprascrie fără `--force`. `update` face merge aditiv doar pe cheile lipsă la nivel top-level, fără sa atinga valorile existente sau chei custom ale userului (fără deep-merge — simplificare deliberată, documentată). +9 teste (unitare + CLI round-trip). 281/281 teste, phase0/phase2 demo PASS. Cea mai mică etapă până acum, sub estimarea inițială (75-105k) |
| 9 | start | 5. Onboarding submodule bootstrap/pilot + docs upgrade | 2026-08-15T00:21:33.359Z | 248,620 | — | = finalul Etapei 4. Citirea IMPLEMENTATION-PLAN.md §5 a scos la iveală `init --engines codex,claude` și propunerea blocului AGENTS.md (§5.2) — lipseau din Etapa 4; foldate aici, nu redeschisă Etapa 4 |
| 10 | end | 5. Onboarding submodule bootstrap/pilot + docs upgrade | 2026-08-15T00:26:19.917Z | 275,825 | **+27,205** | `src/config/agents-md-block.ts` (bloc delimitat+versionat cu marker HTML, propune implicit / scrie doar cu `--write-agents-md`, idempotent) + `--engines` pe `init` (stub-uri goale `adapters.<engine>`); `docs/ONBOARDING.md` nou (bootstrap submodule, upgrade, ce NU atinge update-ul). Gap documentat deliberat: block stale detection nu face auto-replace, doar re-propune. +7 teste. 285/285 teste, phase0/phase2 demo PASS |
| 11 | start | 6. Matrice compatibilitate Codex/Claude | 2026-08-15T00:26:19.917Z | 275,825 | — | = finalul Etapei 5 |
| 12 | end | 6. Matrice compatibilitate Codex/Claude | 2026-08-15T00:30:19.415Z | 293,359 | **+17,534** | `schemas/compatibility-matrix.schema.json` + `docs/compatibility-matrix.json` (date, nu cod runtime — nimic din CLI nu o citește, e pentru oameni + contract tests). Exportat `REQUIRED_HELP_CAPABILITIES` din `claude-cli.ts`/`codex-cli.ts` și `defaultCodexConfig`/`defaultClaudeConfig` din `doctor.ts` (erau private) ca sa poata fi comparate. Test de "drift" dedicat: compară matricea cu constantele reale din cod, eșuează dacă diverg — previne desincronizarea silențioasă a documentației. +4 teste. 289/289 teste, phase0/phase2 demo PASS. Cea mai mică etapă până acum, sub estimarea inițială (40-55k) |
| 13 | start | 7. Package/plugin shims opționale | 2026-08-15T00:30:19.415Z | 293,359 | — | = finalul Etapei 6. §12.1/§12.2 din plan au dat locațiile exacte (`.codex/agents/*.toml` + `.agents/skills/.../SKILL.md`; `.claude/agents/*.md` + `.claude/skills/.../SKILL.md`), listate deja ca livrabil Faza 1 ("installer și skill Codex minimal") dar neconstruite până acum |
| 14 | end | 7. Package/plugin shims opționale | 2026-08-15T00:34:59.552Z | 314,984 | **+21,625** | `templates/shims/{codex,claude,shared}/*` + `src/config/shims.ts` (`installShims()`, niciodată nu suprascrie); `init --install-shims` (opt-in, folosește `--engines` deja existent). Onestitate explicită: shim-ul TOML Codex e marcat "best-effort, neverificat live" (spre deosebire de restul adaptoarelor, unde fiecare comportament e verificat live) — nu am inventat un format ca fiind confirmat. +7 teste. 296/296 teste, phase0/phase2 demo PASS. Sub estimarea inițială (35-50k) |
| 15 | start | 8. Decizia canalului de distribuție | 2026-08-15T00:34:59.552Z | 314,984 | — | = finalul Etapei 7 |
| 16 | end | 8. Decizia canalului de distribuție | 2026-08-15T00:38:45.017Z | 334,483 | **+19,499** | **Nicio implementare de cod** — etapa era marcată explicit în plan drept "decizie + config, nu cod greu, necesită input de la user". Am scris `docs/DISTRIBUTION.md` (4 opțiuni, trade-off-uri reale inclusiv constrângerea de path-resolution descoperită prin construirea Etapelor 1-7) + item nou #13 în `todo.md`, conform instrucțiunii din CLAUDE.md pentru task-uri care așteaptă o decizie de produs. Nu am ales unilateral canalul — e o decizie greu reversibilă (ar cere migrarea repo-urilor deja onboardate). Doar documentație, zero cod/teste noi — de-aici tokenii per pagină de documentație densă. Sub estimarea inițială (45-65k) |

## Part B / Phase 4 — delta real vs. estimat (2026-08-15, după Etapa 8)

Comparație între estimarea prezentată userului înainte de start (bazată pe interval S/M/L
ponderat cu calibrarea reală din Faza 3, ~11.7k tokeni/pp median) și consumul real măsurat
via auto-checkpoint (secțiunea de mai sus).

| Etapă | Estimat (interval) | Estimat (mijloc) | Real (Δ context) | Real / Estimat mijloc |
|-------|---------------------|-------------------|-------------------|------------------------|
| 1. Provider skeleton | 70-95k | 82.5k | 62,345 | 76% |
| 2. Wire health/brief/refresh | 60-80k | 70k | 31,594 | 45% |
| 3. Export handoff redactat | 40-55k | 47.5k | 25,724 | 54% |
| 4. init/update | 75-105k | 90k | 19,588 | 22% |
| 5. Onboarding + docs | 30-40k | 35k | 27,205 | 78% |
| 6. Matrice compatibilitate | 40-55k | 47.5k | 17,534 | 37% |
| 7. Shims opționale | 35-50k | 42.5k | 21,625 | 51% |
| 8. Decizie distribuție (doar docs) | 45-65k | 55k | 19,499 | 35% |
| **Total** | **395-545k** | **470k** | **225,114** | **~48%** |

**Concluzie: consumul real a fost aproximativ jumătate din estimarea inițială**, cu
variație mare per etapă (22%-78%), nu doar o eroare sistematică constantă.

**De ce**: estimarea inițială a fost derivată prin ponderarea complexității relative ×
calibrarea Fazei 3 (~11.7k tokeni/pp per etapă de dimensiune similară cu "1 modul + 5-6
teste"). Faza 3 includea însă etape cu descoperire reală costisitoare — debugging live,
prima integrare a unui subsistem nou, validare cu motor real (Etapa 10 din Faza 3 a fost
+13pp pentru un singur bloc mare). Etapele din Part B, în schimb, au reutilizat aproape
tot timpul convenții deja stabilite **în aceeași sesiune**, la Part A: exact același
pattern de schemă JSON (`schemas/*.schema.json` cu `$id`, `additionalProperties: false`),
exact același pattern de fake-CLI-via-`process.execPath` pentru teste, exact același
checkpoint script reutilizat de 8 ori fără regenerare. Costul de "descoperire" (citit cod
existent, decis convenția) a fost plătit o singură dată în Part A, nu per etapă — de-aici
raportul mult sub 1 pentru aproape toate etapele, cu excepția Etapei 5 (78% — a inclus o
recitire atentă a IMPLEMENTATION-PLAN.md §5 care a scos la iveală goluri reale în Etapa 4)
și Etapei 1 (76% — singura etapă cu adevărat de la zero, fără pattern anterior de urmat).

**Recalibrare pentru estimări viitoare similare**: pentru etape aditive de dimensiune
mică-medie într-o sesiune care deja a stabilit convențiile relevante (scheme, pattern-uri
de test, module similare), un raport de **~0.45-0.5× estimarea derivată din calibrarea
Fazei 3** e un predictor mult mai bun decât intervalul brut ponderat pe complexitate. Când
o etapă chiar introduce ceva de la zero sau cere recitirea atentă a specificației (ca
Etapele 1 și 5), raportul urcă spre 0.75-0.8×.

**Ce NU s-a recalibrat**: raportul tokeni/punct-procentual (~11.7k/pp) rămâne cel din Faza
3 — nu există o citire `/usage` proaspătă asociată acestor 225,114 tokeni din Part B, deci
nu poate fi produsă o pereche reală (tokeni, %5h) nouă fără o citire manuală a userului.
Dacă userul oferă `/usage` curent, poate fi calculată o pereche de calibrare la o scară
mult mai mare (225k tokeni dintr-o singură sesiune de lucru continuă) decât cele 6 perechi
existente (toate sub 60k tokeni fiecare).

**Citire `/usage` primită 2026-08-15 după Etapa 8**: `%5h` afișează 0% — fereastra de 5h
s-a resetat între timp (trecuseră >5h de la baseline-ul "10%" raportat înainte de
Etapa 1), deci acel număr e contaminat și NU produce o pereche de calibrare validă pentru
%5h. `%săpt` afișează 14% (față de baseline-ul 11% raportat înainte de Etapa 1) → **+3pp
%săpt pentru cei 225,114 tokeni din Part B** — dar cu o rezervă reală de atribuire:
`/usage` însuși precizează "Last 7d: 2411 requests, 12 sessions" pe această mașină, deci
delta de +3pp poate include și alte sesiuni Claude Code rulate în paralel/între timp, nu
doar această sesiune. Tratez această pereche ca **slabă/aproximativă** (spre deosebire de
cele 6 perechi din Faza 3, toate strict single-session, citite imediat înainte/după
fiecare etapă) — utilă ca ordine de mărime (~75k tokeni/pp %săpt, plauzibil dat fiind
raportul empiric %5h:%săpt de ~9:1 observat în Faza 3, care ar da ~9.4k tokeni/pp %5h,
în intervalul 9.4-13.4k deja calibrat), dar nu suficient de curată pentru a înlocui
calibrarea existentă.

**Calibrare (Etapele 3-5, 2026-08-14):** ~9.4-13.4k tokeni de context per punct procentual din fereastra 5h, pe planul Claude Pro — trei puncte reale (13.2-13.4k Etapa 3, ~11.7k Etapa 4, ~9.4k Etapa 5), toate pentru module de complexitate similară (1 modul + 5-6 teste). Tendința ușor descrescătoare pe măsură ce sesiunea avansează (context total tot mai mare) sugerează că nu e un raport perfect constant — posibil efect de cache crescând în aceeași sesiune lungă, nu doar zgomot de măsurare. Nu e încă suficient pentru a confirma liniaritatea pe etape mult mai mari sau mai mici — se recalibrează pe măsură ce se adună mai multe perechi. Notă din `/usage`: 95-96% din consumul ultimelor 24h a fost la >150k context — sesiunile lungi (ca aceasta) costă mai mult chiar cu cache hit 99%, deci raportul tokeni/pp măsurat aici e specific unei sesiuni lungi, continue, nu neapărat unei sesiuni noi/scurte.

## Task A — reviewer independent real (2026-08-15, post Part B)

Primul item din raportul "ce mai e de implementat" (după Part B / Faza 4), auto-tracked
cu aceeași metodă de citire a transcript-ului propriu.

| Checkpoint | Timestamp | Context (input+cache_read+cache_creation) | Δ tokeni |
|---|---|---|---|
| start | 2026-08-15T08:24:08.011Z | 370,491 | — |
| end | 2026-08-15T08:37:44.542Z | 463,889 | **+93,398** |

Estimat inițial: 90-150k. Real: 93,398 — aproape de capătul de jos al intervalului, deși
task-ul s-a dovedit mai mare decât părea din `todo.md` #9 (a necesitat și un
`executeRepairCycle` stub, nu doar reviewer-ul, ca `runIndependentReviewAndRepair` să
poată fi conectat funcțional în `cli.ts`). Consistent cu recalibrarea din Part B: chiar
și pentru munca "cu adevărat nouă" (fără pattern direct de copiat), reutilizarea
convențiilor de test (fake-CLI-via-`process.execPath`, scheme JSON, checkpoint script)
ține costul aproape de estimarea de jos, nu de mijlocul intervalului.

## Task D — find-symbol/impact-analysis per task (2026-08-15)

Următorul item neblocat din listă (B și C rămân blocate pe decizii ale userului — vezi
raportul). Notă metodologică: checkpoint-ul de start (472,302) a fost citit după o
recompactare a contextului între Task A și Task D (cache_creation dominant vs.
cache_read dominant în citirea brută) — totalul e continuu cu finalul Task A, deci
delta rămâne validă, dar semnalată explicit conform avertismentului metodologic de mai
sus.

| Checkpoint | Timestamp | Context | Δ tokeni |
|---|---|---|---|
| start | 2026-08-15T10:12:16.214Z | 472,302 | — |
| end | 2026-08-15T10:18:25.036Z | 500,106 | **+27,804** |

Estimat inițial: 15-25k. Real: 27,804 — ușor peste capătul de sus. Design fără
euristică inventată: câmp nou opțional `relevantSymbols` pe task-ul din manifest
(declarat explicit de autorul planului, nu dedus automat), lookup la nivel de run (nu
per-task, ca să nu atingă bucla internă a celor trei runners) pentru fiecare simbol
unic din toate task-urile. +2 teste CLI. 312/312 teste, phase0/phase2 demo PASS.

## Task E — auto-replace bloc AGENTS.md stale (2026-08-15)

| Checkpoint | Timestamp | Context | Δ tokeni |
|---|---|---|---|
| start | 2026-08-15T10:41:31.757Z | 504,236 | — |
| end | 2026-08-15T10:47:37.048Z | 529,822 | **+25,586** |

Estimat inițial: 5-10k (polish minor). Real: 25,586 — cu mult peste, dintr-un motiv
real: implementarea detecției STALE a scos la iveală un bug separat, mai important —
`agentsMd`/`shims` din `init` erau legate de `result.status === "CREATED"`, deci un
`init --write-agents-md` repetat (cazul de upgrade documentat chiar în
`docs/ONBOARDING.md`) nu făcea NIMIC, pentru că al doilea apel dă `ALREADY_EXISTS`.
Fixat în același commit (decuplat de status-ul config-ului) — fără acest fix, feature-ul
STALE→REPLACE ar fi fost complet inaccesibil prin CLI. +5 teste (3 unitare STALE/
malformed, 2 CLI end-to-end pentru ambele fix-uri). 317/317 teste, phase0/phase2 demo
PASS, zero regresii.
