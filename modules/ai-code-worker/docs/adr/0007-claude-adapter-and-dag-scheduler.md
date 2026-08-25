# AICW-ADR-007: Adaptorul Claude Code și scheduler-ul DAG paralel

- Status: acceptat
- Data: 2026-08-10
- Owner: developer experience
- Plan asociat: [planul de implementare v1.2](../IMPLEMENTATION-PLAN.md), secțiunea Faza 2

## Context

Faza 2 cere un al doilea adaptor de motor (Claude Code, headless) alături de Codex, plus
un scheduler capabil să lanseze task-uri independente ca writeri concurenți atunci când
manifestul o permite. Codex rămâne referința: `CodexCliAdapter` face `doctor()`,
construiește o invocare non-interactivă, și normalizează rezultatul în contractele
`EngineEvent`/`AgentExecutionResult` existente (ADR-005), fără a le modifica.

## Decizie

### Adaptorul Claude

`ClaudeCliAdapter` (`src/engines/claude-cli.ts`) oglindește exact forma lui
`CodexCliAdapter`. Diferențele față de Codex sunt rezultatul unor teste live împotriva
CLI-ului real instalat (2.1.177), nu presupuneri din documentație:

- `--json-schema` este documentat în `claude -p --help`, dar **blochează procesul la
  infinit** la runtime, indiferent de starea de autentificare (`--bare` vs. keychain),
  modul de livrare a prompt-ului (stdin vs. argument pozițional), sau `--output-format`.
  Adaptorul nu îl folosește. Output-ul structurat este garantat prin instrucțiune în
  prompt plus validarea schema client-side deja existentă în `readAgentResult()` -
  aceeași garanție fail-closed, fără dependență de un flag documentat dar nefuncțional.
- Prompt-ul este livrat prin stdin (fără argument pozițional), confirmat funcțional
  printr-o invocare live (`echo ... | claude -p --output-format text`).
- `--bare` nu citește OAuth/keychain (documentat explicit în `--help`) și necesită
  `ANTHROPIC_API_KEY`. Nu e folosit implicit: worker-ul trebuie să se autentifice la fel
  ca o sesiune interactivă `claude` de pe aceeași mașină (login prin subscripție), nu
  prin cheie API. `--bare` rămâne opt-in prin `ClaudeCliAdapterConfig.bareMode`, pentru
  medii headless provizionate deliberat cu o cheie API. Confirmat printr-o invocare
  live `adapter.start()` completă, nu doar `doctor`.
- Nu se acordă Bash (`--tools "Read,Edit,Write,Grep,Glob"`). Worker-ul face oricum
  commit-urile; Claude nu are nevoie de Bash pentru a termina un task, iar
  `--disallowedTools` cu prefix-uri (`Bash(git commit *)`) ar fi o gardă mai slabă,
  ocolibilă prin comenzi compuse.

### Scheduler-ul DAG

Scheduler-ul (`src/run/dag-scheduler.ts`, `src/policy/concurrency-policy.ts`) este construit
peste `readyTasks()` existent din `src/graph/task-graph.ts` (nemodificat), nu îl
înlocuiește. `nextDispatchWave()` calculează setul ready curent și îl partiționează în
valuri compatibile prin `partitionIntoWaves()`, plafonate la `maximumParallelWriters`.

Compatibilitatea între două task-uri (`tasksOverlap()`) este blocantă dacă:

1. cele două task-uri au un `concurrencyKey` comun; sau
2. orice pereche de pattern-uri din `allowedPaths` ar putea potrivi același fișier
   concret (verificare de tip strămoș-sau-egal pe arborele de directoare).

Ambiguitatea în (2) se rezolvă spre a declara suprapunere (serializarea inutilă e
sigură; doi writeri pe același fișier nu sunt).

**Scop redus deliberat**: valurile paralele sunt cuplate doar în `fake-run.ts`.
`codex-run.ts`/`claude-run.ts` păstrează bucla secvențială strictă existentă. Motivul:
`CodexCliAdapter`/`ClaudeCliAdapter` folosesc `spawnSync`, nu `spawn` asincron -
paralelismul real la nivel de apel de motor ar cere conversia ambelor adaptoare, cu
schimbări la gestionarea timeout-ului și erorilor. Decizia acceptată pentru această
fază: paralelism la nivelul worktree-urilor și commit-urilor, apeluri de motor tot
secvențiale în interiorul unui val. Acoperă criteriul de ieșire (task-uri incompatibile
nu pornesc în paralel, task-uri compatibile rulează și se integrează determinist) fără
riscul mai mare al conversiei async.

### Integrare și conflict report

După ce bucla de valuri se termină (numai când `maximumParallelWriters > 1`),
`integrateTaskCommits()` (`src/run/integration.ts`) face cherry-pick pe fiecare commit
de task, în ordine topologică deterministă, pe un worktree de integrare dedicat
(creat cu `createTaskWorktree`, `taskId: "__integration__"`). Primul conflict oprește
integrarea și scrie `conflict-report.json` cu task-ul, commit-ul, căile în conflict și
stderr-ul lui Git - niciodată succes parțial. `cherryPickCommit()`
(`src/git/cherry-pick.ts`) face abort explicit pe conflict, lăsând worktree-ul curat.

### Sync-root la momentul lansării

`enforceSyncRootForParallelDispatch()` (`src/git/sync-root.ts`) este un apel separat
de `evaluateSyncRootPolicy()` folosit de `doctor`: pentru orice val cu mai mult de un
writer, blochează necondiționat dacă `git-common-dir` e sub un sync-root cunoscut
(OneDrive/Dropbox/iCloud/Google Drive), indiferent de `syncRootPolicy` configurat în
repo. Scriitorul secvențial rămâne la comportamentul de `warn` existent din Faza 0/1.
La blocare, val-ul se degradează la un singur task în loc să oprească tot run-ul.

## Consecințe

- Testele de contract Claude nu apelează niciodată un model real (`writeFakeClaudeCli`).
- Suita de teste existentă (fake-run, codex-run, doctor) rămâne verde neschimbată -
  proba concretă că `maximumParallelWriters === 1` reproduce exact secvența anterioară.
- `run --engine codex`/`claude` rămân neatinse de scheduler; paralelismul real pentru
  motoarele reale e follow-up explicit, nu implicit.

## Alternative respinse

- Conversia `CodexCliAdapter`/`ClaudeCliAdapter` la `spawn` asincron pentru paralelism
  real la nivel de apel de motor: risc mai mare, neesențial pentru criteriul de ieșire
  al Fazei 2 așa cum e formulat.
- Refolosirea `--json-schema` cu retry/timeout mai mare: flag-ul e nefuncțional, nu
  lent; niciun timeout rezonabil nu ar fi rezolvat blocarea observată.
- `--disallowedTools` cu prefix-uri pentru Bash în loc de a nu acorda deloc Bash: gardă
  mai slabă, ocolibilă.

## Acceptance tests

1. `doctor --engine claude` distinge PASS / BLOCKED (versiune lipsă, netestată, smoke
   test eșuat), verificat și live împotriva CLI-ului real instalat.
2. `run --engine claude` produce un `AgentExecutionResult` valid din fixture-ul fals,
   cu identitate `runId`/`taskId` corectă.
3. Două task-uri fără suprapunere de `allowedPaths`/`concurrencyKeys` sub
   `maximumParallelWriters: 2` sunt dispecerizate într-un singur val și se integrează
   determinist.
4. Două task-uri cu `allowedPaths` suprapuse nu ajung niciodată în același val, chiar
   sub un plafon de paralelism mai mare.
5. Un conflict de cherry-pick la integrare produce `conflict-report.json` și `BLOCKED`,
   niciodată succes parțial.
6. Un val cu mai mult de un writer sub un sync-root detectat este blocat necondiționat,
   indiferent de `syncRootPolicy` configurat.
