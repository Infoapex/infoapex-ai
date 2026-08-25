# TODO — ai-code-worker

## Historical status (superseded by the current status below)

## Current status (2026-08-25)

Implemented in this batch:

- #14 dynamic Claude/Codex discovery and behavioral compatibility gating.
- #21 per-task `ai-code-control` brief/symbol context injection, bounded and advisory.
- #13 worker-side distribution decision recorded as pinned submodule for bootstrap/pilot; no packaging shim is needed until `infoapex-ai` defines the umbrella installer contract.
- #20 bounded per-task routing and mid-task availability fallback. The worker now freezes an ordered candidate list from `routing-policy.json`, records it in the manifest, and only advances on classified provider availability/quota signals.
- `infoapex-ai` handoff: when explicitly enabled, worker publishes versioned `worker-to-planner.json` feedback. Standalone runs do not read or write the channel.

Still intentionally open:

- Production acceptance of #20. Current CLI adapters expose provider failures as a generic engine class, so the bounded message classifier is covered by tests but still needs live validation against stable Claude/Codex quota responses before this can be called a fully proven production failover.

The remainder of this section is the historical investigation log from 2026-08-15/16.

Din raportul "ce mai e de implementat" pentru ai-code-worker: task-urile A (reviewer
independent real), D (find-symbol/impact per task) și E (auto-replace bloc AGENTS.md
stale) sunt **complete și pushed**. Rămân neimplementate, ambele așteptând clarificări
înainte să pot începe:

- **#13** — config-ul pentru canalul de distribuție (submodule, deja decis) — vezi
  detalii mai jos.
- **#14** — detecție dinamică de versiune Claude/Codex (înlocuiește lista hardcodată
  `testedVersionRanges`) — vezi detalii mai jos.
- **#20** — comutare automată de motor (Claude ↔ Codex) în timpul unui task deja
  pornit, pe epuizare reală de credite/tokeni/limită de utilizare. Amânat intenționat
  la #19 (2026-08-16): nu există azi niciun semnal fiabil de rate-limit/cotă epuizată
  în ieșirea CLI a niciunui motor — `AgentExecutionResult.failures[].class` colapsează
  orice eșec neparsabil în `"engine"` generic, nedistins de un bug real. Blocat pe o
  metodă de detecție care nu confundă epuizarea cotei cu un eșec real de motor
  (parsare structurată a stderr/exit code per-motor? un semnal explicit din CLI-urile
  Claude/Codex, dacă există unul? telemetrie de cost care poate anticipa epuizarea
  înainte să lovească?) — cere cercetare/decizie de produs înainte de implementare, nu
  doar cod.
- **#21** — `contextProvider` (integrarea `ai-code-control`) e cablat doar ca
  raportare, nu reduce costul real per task — vezi detalii mai jos. Găsit prin
  dogfooding real: un audit de tokeni pe `ai-code-planner` a arătat ~8.3M tokeni
  pentru 6 task-uri, fiecare redescoperind repo-ul de la zero.

Ambele legate de `docs/INFOAPEX-AI-VISION.md` (installer-ul umbrelă `infoapex-ai`,
neimplementat încă).

## Găsite prin dogfooding din `ai-code-planner` (2026-08-15/16)

Primul consumator extern real al lui `ai-code-worker` (proiectul independent
`ai-code-planner`) a scos la iveală mai multe goluri, toate verificate direct în cod,
nu presupuse din documentație.

> **Numerotare:** itemii de mai jos (15-19) continuă după itemii 1-14 din secțiunea
> „Itemi"/„Faza 3" de mai jos în document, care sunt anteriori acestei sesiuni. Primele
> patru din secțiunea de față au fost etichetate greșit 11-14 la momentul scrierii —
> coincidență de numerotare cu itemii 11-14 din cealaltă secțiune, nu aceleași itemi.
> Corectat aici; niciun conținut nu s-a schimbat, doar eticheta.

### 15. `project-config.schema.json` declara 7 câmpuri `required` pe care nimic nu le citește — done 2026-08-15

`ai-code-worker init` genera un `config.json` care nu trecea propria schemă
(`additionalProperties: false`, `required` includea `defaultEngine`, `baseBranch`,
`integrationBranchPrefix`, `taskBranchPrefix`, `maximumRepairCycles`,
`maximumRunMinutes`, `executionEnvironment`). Părea un bug în `init.ts`.

**Nu era.** `src/config/init.ts`'s `defaultProjectConfigTemplate()` are deja un
comentariu explicit: aceste câmpuri sunt aspiraționale, documentate în
`IMPLEMENTATION-PLAN.md §6`, dar nimic din runtime nu le citește din `config.json` —
verificat cu `grep` pe tot `src/`: `maximumRepairCycles`/`maximumRunMinutes` chiar sunt
citite, dar din `manifest.budgets` (manifestul înghețat), nu din `config.json`;
`defaultEngine`/`baseBranch`/`integrationBranchPrefix`/`taskBranchPrefix`/
`executionEnvironment` (ca proprietate de config) nu sunt citite nicăieri.

Deci schema era artefactul stale, nu `init.ts`. Fix: `required` redus la ce chiar se
citește (`schemaVersion`, `contextProvider`, `maximumParallelWriters`, `stateRoot`,
`syncRootPolicy`); câmpurile aspiraționale rămân ca proprietăți opționale documentate,
cu `description` care explică exact ce citește runtime-ul în locul lor și unde. Nimic
din runtime nu s-a schimbat — doar schema a fost adusă la realitate.

### 16. `testedVersionRanges` lipsea din schemă deși codul îl citește deja — done 2026-08-15

Descoperit în timpul unei sesiuni de debugging Codex-not-on-PATH aproape identică cu
item #10 de mai jos (versiune diferită, locație diferită a binarului). `doctor` bloca
cu `CODEX_VERSION_UNTESTED` pe o instalare reală, funcțională. Overide-ul de proiect
(`adapters.codex.testedVersionRanges` în `config.json`) funcționează la runtime —
`AdapterProjectConfig` din `src/config/project-config.ts` îl declară deja, iar
`codexAdapterConfigFromProject()`/`claudeAdapterConfigFromProject()` din
`src/doctor/doctor.ts` îl citesc — dar `project-config.schema.json` nu-l lista pe
niciunul din cei doi adaptori, cu `additionalProperties: false`. Divergență silențioasă
între tip și schemă, nedescoperită pentru că nimic nu validează `config.json` contra
schemei la runtime (confirmat citind `doctor.ts`, `compile.ts`,
`project-config.ts::loadProjectConfig`). Fix: adăugat `testedVersionRanges` ca
proprietate documentată pe ambii adaptori.

### 17. `executeRepairCycle` real pentru motorul `fake` — done 2026-08-15, parțial (vezi rest la #9 și #18)

Cerință directă a userului: worker-ul trebuie să se auto-corecteze, nu doar să
blocheze. Item #9 lăsase execuția reală de repair complet neconstruită
(`no-repair-capability-executor.ts` raportează `FAILED` necondiționat).

Măsurat înainte de a construi: `runClaude`/`runCodex` sunt funcții monolitice de 500+
linii, cu dispatch-ul per-task împletit cu recovery/checkpoint/numerotare de evenimente
— nu există o funcție „rulează un singur task" reutilizabilă direct pentru un
`RepairTask`. Extragerea completă e o schimbare mare pe cod cu 317+ teste, folosit deja
de consumer project și `ai-code-planner`. Urmat exact secvențierea proprie din
`HANDOFF-PHASE-3-CLAUDE.md`: „doar după ce acoperirea deterministă (fake) e verde, se
trece la adaptoarele reale."

Construit `src/repair/execute-fake-repair-cycle.ts` — `createFakeRepairExecutor()`,
un `RepairCycleExecutor` real pentru motorul `fake`: worktree real per repair task
(`createTaskWorktree`), scriere de fișier reală ca stand-in pentru fix-ul motorului
(`FakeEngineAdapter` nu are efecte pe disc, la fel ca `writeFakeTaskOutput` din
`fake-run.ts`), commit real (`createWorkerCommit`), și — partea pe care toate testele
existente o săreau, hardcodând `outcome: "PASSED"` — **rulează efectiv comenzile
`verify` ale task-ului** (`resolveQualityGate`/`runQualityGateSync`) și decide
PASSED/FAILED din codul de ieșire real, nu dintr-o presupunere. Review-ul de după ciclu
e injectat (`reviewer` obligatoriu în opțiuni), nu hardcodat curat.

Cerut și implementat: `RepairCycleExecutionContext` (în `repair-cycle.ts`) extins cu
`findings: readonly IngestedFinding[]` — fără findings reale, `buildRepairPrompt` nu
avea ce insera în prompt (`RepairTask.sourceFindingIds` sunt doar ID-uri). Schimbare
aditivă, verificată sigură (niciun test existent nu construia contextul manual).

4 teste noi în `tests/unit/execute-fake-repair-cycle.test.ts`, inclusiv testul care
contează cel mai mult: un `verify` care nu poate trece pe conținutul real scris
întoarce `FAILED` cu commit real dar fără succes fals raportat. 321/321 teste, zero
regresii.

**Ce rămânea neconstruit mai sus a fost făcut ulterior, 2026-08-16** — vezi item #18.

### 18. `executeRepairCycle` real pe motoare REALE (Claude/Codex) — done 2026-08-16

Continuare directă a #17, cerută explicit: „conectez auto-corectarea și la Claude/Codex
reali", nu doar la motorul de test.

**Nu a fost nevoie de extragerea din `runClaude`/`runCodex` pe care o evitasem la #17.**
Descoperire care a schimbat planul: `ClaudeCliAdapter`/`CodexCliAdapter` expun deja
`.start()` ca metodă publică, de sine stătătoare — exact contractul de care are nevoie
o reparare (worktree → prompt → engine → commit → verify), fără să atingă bucla
principală de 500+ linii. Practic același precedent pe care `independent-reviewer-cli.ts`
îl stabilise deja pentru review (apel standalone la motor, în afara buclei mari) — de
data asta pentru repair.

Construit `src/repair/execute-real-engine-repair-cycle.ts::createRealEngineRepairExecutor()`
(motor injectat, deci un singur modul pentru ambele motoare) + wrapper-e mici
`execute-claude-repair-cycle.ts`/`execute-codex-repair-cycle.ts` care construiesc
adaptorul exact cum o fac `runClaude`/`runCodex` (funcțiile lor `claudeConfig`/
`claudeAdapterConfigFromProject`/`codexConfig`/`codexAdapterConfigFromProject`, acum
exportate — singura modificare aditivă asupra lor). Ca la #17: engine-ul rulează, dar
`verify` decide PASSED/FAILED, nu răspunsul autoraportat al motorului.

**Descoperire reală în timpul construcției, nu presupusă**: `runClaude`/`runCodex` nu
integrează niciodată task-urile pe un branch comun — fiecare rămâne pe commit-ul lui
izolat (spre deosebire de `fake-run.ts`, care are un pas de integrare condiționat de
paralelism). Fără fix, un worktree de reparare pornit din `manifest.base.commit` ar fi
fost gol de munca task-urilor originale — inclusiv fișierul cu problema de reparat.
Fix: adăugat un pas de integrare (reutilizează `integrateTaskCommits`, deja testat, deja
folosit de `fake-run.ts`) chiar înainte de apelul de reparare, în ambii runners, rulat
doar când reparerea chiar se încearcă (review eșuat + `independentReview` furnizat), nu
pe drumul fericit. Commit-ul de bază rezultat nu putea fi cunoscut de CLI dinainte —
`executeRepairCycle` a devenit o fabrică (`(repairBaseCommit: string) => RepairCycleExecutor`)
în loc de valoare fixă, în ambii runners; schimbare aditivă, niciun test existent nu
construia tipul manual (doar `cli.ts` a trebuit actualizat).

Cablat în `cli.ts`: `--engine claude|codex --independent-review` folosește acum
executorii reali, cu reviewer-ul real deja construit (`createClaudeIndependentReviewer`/
`createCodexIndependentReviewer`) reutilizat ca re-review după fiecare ciclu.

3 teste noi end-to-end prin `runClaude`/`runCodex` reale (CLI fals via
`writeFakeClaudeCli`/`writeFakeCodexCli`, exact tiparul deja stabilit în
`claude-run.test.ts`/`codex-run.test.ts`): cazul pozitiv (motorul scrie fix-ul corect,
`verify` trece, commit real, `DONE`) și cazul negativ pentru Claude (motorul rulează,
face commit real, dar pe conținut greșit — `verify` tot eșuează, `BLOCKED` cu
`REPAIR_DID_NOT_RESOLVE_REVIEW`, nu `DONE` fals). 324/324 teste, zero regresii.

Rămâne neschimbat, deliberat: motorul `fake` nu are wiring CLI pentru
`--independent-review` (fără corespondent de reviewer real, per raționamentul de la
#17).

### 19. Cross-review Claude/Codex + failover la nivel de `doctor` — done 2026-08-16

Cerință directă a userului, formulată ca întrebare deschisă: „mi-as dori cumva cele 2
llm-uri sa comunice pe cod si sa isi impartaseasca descoperirile [...] doar in cazul in
care lucreaza in paralel pe task-uri diferite [...] daca unul ramane fara credite /
tokeni / limita de utilizare celalalt trebuie sa preia task-ul. sau daca gresesc spune-mi
tu cum ar trebui worker-ul sa se comporte?" — a invitat explicit corecția.

**Verificat înainte de a construi, nu presupus:** coliziunea pe task-uri paralele e deja
rezolvată structural, fără nicio comunicare între motoare. `tasksOverlap()`/
`partitionIntoWaves()` din `src/policy/concurrency-policy.ts` folosesc `allowedPaths`/
`forbiddenPaths`/`concurrencyKeys` din plan pentru a separa task-urile în valuri fără
suprapunere de scop — niciun LLM nu trebuie să „anunțe" celuilalt ce a atins, mecanismul
există deja și e testat. La fel, „cine a implementat ce" e deja urmărit exact —
`report.taskCommits` mapează fiecare `taskId` la commit-ul lui, iar `manifest.tasks[].role`
+ adapter-ul folosit la rulare identifică motorul.

**Failover automat pe epuizare de credite/tokeni la mijlocul unui task — verificat și
respins ca nesigur de construit azi.** Grep pe `AgentExecutionResult.failures[].class`
(`"deterministic"|"flaky"|"infrastructure"|"policy"|"engine"`): nu există nicio detecție
reală de rate-limit/cotă epuizată — orice eșec CLI neparsabil colapsează generic în
`class: "engine"`. A comuta motorul automat pe baza acestui semnal ar risca să mascheze
bug-uri reale (eșec de motor confundat cu epuizare de cotă) — deci **nu s-a construit**.
Rămâne un gap onest, nu ascuns.

**Ce s-a construit în schimb, sigur de implementat:** două mecanisme independente în
`src/cli.ts`.

1. **Failover la nivel de `doctor`, înainte de orice task** — flag nou `--fallback-engine
   <claude|codex>`. Dacă motorul cerut (`--engine`) eșuează la `doctor()` (semnalul curat,
   detectabil: `CLAUDE_VERSION_UNAVAILABLE`/`CODEX_SMOKE_TEST_FAILED` etc., înainte de a
   porni orice task), iar motorul de fallback trece `doctor()`, run-ul comută pe el automat
   și raportează comutarea. Dacă și fallback-ul e indisponibil, comportamentul rămâne
   neschimbat — calea existentă de `doctor` blocat raportează eroarea reală, fără fallback
   silențios.
2. **Cross-review by default** — când `--independent-review` e activ, reviewer-ul implicit
   e acum CELĂLALT motor față de cel care a implementat task-ul (verificat via
   `checkEngineAvailable()`), nu mereu același motor care s-a auto-revizuit. Dacă motorul
   opus e indisponibil la `doctor()`, cade grațios pe review cu același motor, cu notificare
   vizibilă în consolă — nu blochează run-ul.

Ambele mecanisme raportate transparent în output: `engineProvenance` (JSON și consolă) —
`requestedEngine`, `engineUsed`, `engineFallbackTriggered`, `reviewEngine`.

4 teste noi în `tests/unit/cli-engine-failover.test.ts`, la nivel de subproces real (nu
in-process) — invocă `dist/src/cli.js` prin `execFileSync`, exact tiparul din
`cli-executable-flags.test.ts`. Bug găsit și fixat pe parcurs: `--codex-executable`/
`--claude-executable` setează executabilul direct, fără flag pentru `baseArgs`, iar
script-urile `.mjs` false nu sunt direct executabile pe Windows (shebang-urile nu sunt
interpretate) — fixat cu un wrapper `.cmd` (`wrapAsExecutable()`) care rutează prin
`needsShellWrapper()`, deja existent în `src/engines/spawn-shell.ts`. 328/328 teste, zero
regresii.

**Rămâne neconstruit, deliberat:** orice comutare de motor în timpul unui task aflat deja
în execuție, declanșată de epuizare reală de cote/tokeni — nu există azi un semnal fiabil
pentru asta în ieșirea CLI a niciunui motor.

### 21. `contextProvider` (ai-code-control) e cablat doar ca raportare, nu reduce costul real per task — găsit 2026-08-16, neconstruit

Descoperit prin dogfooding real, nu presupus: userul a cerut un audit de ce Faza 1 a
`ai-code-planner` a costat ~8.3M tokeni / ~$9.5 pentru 6 task-uri (de ~15-20× peste
estimarea inițială). Root cause principal confirmat: fiecare task e o invocare
`claude -p --no-session-persistence` complet izolată, care redescoperă repo-ul de la
zero (CLAUDE.md/AGENTS.md/README, fișierele din `requiredInputs`, fișierele surori)
prin Read/Grep/Glob reale, de fiecare dată. Userul a întrebat, rezonabil: de ce
`ai-code-control` (indexare + memorie) nu reduce acest cost, dat fiind scopul lui
declarat ("context provider")?

**Verificat direct în cod, nu presupus:**

- `claudePrompt()` (`src/run/claude-run.ts`) — prompt-ul chiar trimis motorului per
  task conține: metadate task, `allowedPaths`/`forbiddenPaths`, `acceptanceCriteria`,
  `verify`, și `requiredInputs` ca **listă de căi**, nu conținut rezolvat. Nimic din
  `ai-code-control` nu apare aici, indiferent de `contextProvider`.
- `contextProvider.health()`/`.brief()` (`src/cli.ts`) rulează **o singură dată per
  rulare**, nu per task, înainte de compilare.
- `findSymbol`/`impact` rulează doar pentru simboluri declarate explicit în
  `relevantSymbols` per task (nicio euristică automată — decizie corectă, documentată
  în cod: "ai-code-worker nu poate deriva ce simboluri atinge un task, asta rămâne în
  afara scopului").
- Toate trei (`health`/`brief`/`findSymbol`/`impact`) ajung **doar în raportul JSON
  final** (`contextProviderSummary`), niciodată injectate înapoi în promptul pe care
  motorul îl vede înainte să scrie cod. Comentariul din cod confirmă intenția:
  „Health/brief are advisory only... no behavior change."
- Al doilea blocaj, independent: `.ai-code-worker/config.json`'s
  `adapters.claude.allowedTools` e fix `["Read","Edit","Write","Grep","Glob"]` — niciun
  tool `mcp__ai-code-control__*`. Sub `--permission-mode dontAsk`, orice tool neinclus e
  refuzat automat — motorul n-ar putea apela live `find_symbol`/`memory_brief` nici
  dacă ar vrea, chiar dacă serverul MCP ar fi disponibil în subproces.

**Nu e un bug ascuns — e o decizie de design documentată**, consistentă cu invariantul
din `docs/IMPLEMENTATION-PLAN.md` §13: *"ai-code-control oferă context și controale, nu
conduce schedulerul."* Dar specificația nu exclude explicit injectarea în prompt — e o
zonă nedecisă, nu o interdicție. Numele și scopul declarat ("context provider") sugerează
rezonabil că ar trebui să reducă ce trebuie motorul să redescopere singur; ce s-a
construit reduce doar ce trebuie să caute *omul* care citește raportul final.

**Nefixat aici, la cererea userului** (doar documentat) — ar fi o schimbare de
arhitectură nebanală: ce anume din `brief()`/`findSymbol()`/`impact()` s-ar injecta în
`claudePrompt()`, cum se ține promptul din a exploda în dimensiune pentru task-uri cu
mulți `relevantSymbols`, și dacă merită extins `allowedTools` cu tool-uri MCP (cu riscul
de suprafață de atac mai mare per task) sau dacă rezolvarea corectă e rezolvarea
server-side (worker cheamă `ai-code-control` el însuși și injectează rezultatul ca text
static în prompt, fără să dea motorului acces direct la MCP). Cere decizie de produs
înainte de cod.

**2026-08-16, propunere de arhitectură scrisă** (nu implementată încă): userul a cerut
un plan complet de simbioză `ai-code-planner` ↔ `ai-code-worker` ↔ `ai-code-control`,
pornind exact de la acest item. Document salvat în repo-ul consumer project la
`Plan/AICW-ACC-Symbiosis/PLAN.md`, scris pentru audit încrucișat Claude+Codex înainte
de orice cod. Propune 4 mecanisme independente (brief per task, memory-add-task-summary
automat per task, run-validation ca gate, calea hook-urilor Claude Code ca alternativă)
și o listă explicită de ipoteze de verificat empiric înainte de implementare (inclusiv
dacă hook-urile Claude Code chiar rulează în modul headless `-p`, netestat azi). Nu se
lucrează pe acest item până planul nu e revizuit.

## Secvențiere

**Status 2026-08-12: implementat înainte de Faza 3.** Gate-ul de valoare extins rămâne
o condiție de produs pentru adopția largă, dar cele 5 itemuri tehnice de robustețe
descoperite prin dogfooding au fost închise în cod și teste.

Aceste 5 itemi sunt programați **după** „Gate de valoare extins" (în prezent pe pauză,
condiționat de ridicarea îngheței de review manual de pe consumer project) și **înainte** de
Faza 3 (repair, replanning, hardening avansat) din `docs/IMPLEMENTATION-PLAN.md`.

Motivul secvențierii: gate-ul de valoare extins validează dacă worker-ul, așa cum e
acum, produce valoare reală măsurabilă. Itemii de mai jos sunt îmbunătățiri de
robustețe/design descoperite prin dogfooding real (vezi `docs/PHASE-2.md`, secțiunea
„Dogfooding"), nu blocante pentru acel gate — dar ar trebui rezolvați înainte de a
construi Faza 3 (repair/replanning) peste un fundament care încă are aceste goluri
cunoscute.

## Itemi

### 1. Verificare comportamentală a capacităților CLI critice, nu doar prezența în `--help` — done 2026-08-12

`--output-schema` (Codex) și `--json-schema` (Claude) au fost ambele puncte centrale de
design bazate pe documentație/`--help`, și ambele s-au dovedit sparte la runtime:
Claude bloca procesul la infinit, Codex declanșa un tool de răspuns structurat
prematur, blocând turul. Ambele au necesitat eliminare completă din adaptor, nu doar un
fix minor.

**Propunere**: orice capacitate CLI de care un adaptor depinde critic (nu doar
opțional) trebuie verificată printr-un smoke test *comportamental* — o invocare reală,
minimală, care confirmă că flag-ul chiar produce efectul așteptat — înainte de a deveni
parte din design-ul adaptorului. Smoke test-ul de `doctor()` existent verifică doar
prezența unui string în `--help`; asta nu e suficient pentru flag-uri de care
corectitudinea rulării chiar depinde.

Închis prin `behavioralSmokeTest` în doctor-ul Codex/Claude și teste care blochează
revenirea flag-urilor runtime problematice (`--output-schema`, `--output-last-message`,
`--json-schema`) în invocările reale. Structured output rămâne validat client-side.

### 2. Paralelism real pentru motoarele reale (nu doar `fake`) — done 2026-08-12

Scheduler-ul DAG din Faza 2 e cuplat doar la motorul `fake` (decizie deliberată,
documentată în `docs/PHASE-2.md`). Motoarele reale (`CodexCliAdapter`,
`ClaudeCliAdapter`) rămân pe `spawnSync`, deci strict secvențiale chiar și în interiorul
unui val paralel.

**Propunere**: conversia `spawnSync` → `spawn` asincron pentru ambele adaptoare, astfel
încât apelurile de motor real să poată rula efectiv concurent, nu doar worktree-urile și
commit-urile. Implică regândirea gestionării timeout-ului și a erorilor pentru
invocări asincrone — o bucată de lucru reală, nu triviabilă.

Închis prin `spawnBuffered` și `startAsync()` pe `CodexCliAdapter` și `ClaudeCliAdapter`,
cu teste care pornesc două invocări fake-CLI întârziate în paralel. Coordinator-ele
Codex/Claude pot păstra single-writer pentru recovery/commit sequencing, dar adaptorul
nu mai este blocat tehnic de `spawnSync`.

### 3. Gate-uri de task care pot rula build/test real, nu doar grep pe text — done 2026-08-12

Worktree-urile de task nu au `node_modules` (netrackuit de git), deci `verify`/
`globalGates` nu pot rula `npm run build`/`npm test` real — doar comenzi `node -e`
simple, bazate pe text. Confirmat direct printr-un caz real: un task scris de Codex a
trecut toate gate-urile automate, dar conținea un `as` type-assertion care nu făcea
nimic la runtime — compila, dar nu funcționa. Verificarea automată a sistemului nu a
putut prinde asta cu design-ul curent; a fost prins doar prin review manual al diff-ului.

**Propunere**: un mecanism prin care gate-urile de task pot rula o compilare/testare
reală în worktree — de investigat: symlink la `node_modules` din checkout-ul principal
în worktree, sau instalare dedicată per-worktree cu cache. Fără asta, „gate-urile trec"
va continua să însemne mai puțin decât pare pentru task-uri unde corectitudinea reală
depinde de compilare sau de o suită de teste, nu doar de prezența unui string.

Închis prin `linkedDirectories` în `quality-gates.json`: un gate poate lega explicit
directoare runtime din checkout-ul principal în worktree (de exemplu `node_modules`)
înainte de execuție, cu validare că sursa rămâne în repository și ținta în worktree.

### 4. Backend `isolated` real (nu doar `FakeExecutionEnvironment`) — done 2026-08-12

Contractul de izolare (environment scrubbed, network deny, filesystem restricted,
process-tree cancellation) există doar ca implementare fake, din Faza 0. Tot discursul
despre siguranța execuției e încă neverificat împotriva unei implementări reale — un gol
vechi, dar cu cât rămâne nerezolvat, cu atât garanția de izolare e teoretică, nu
demonstrată.

**Propunere**: implementarea unui backend `ExecutionEnvironment` real (per ADR-002),
cu profilul de capabilități verificat efectiv, nu doar declarat.

Închis prin `LocalIsolatedExecutionEnvironment`, folosit de `doctor`, plus test de rulare
cu environment scrubbed, fără shell, timeout/output limits și process cleanup. Network
deny rămâne policy-visible și raportat cu warning deoarece backend-ul local nu este un
sandbox kernel-level.

### 5. Configurare adaptor din linia de comandă (model, permission-mode, sandbox) — done 2026-08-12

`--claude-executable`/`--codex-executable` există acum (adăugate prin dogfooding în
Faza 2), dar restul configurației adaptorului (model, `permission-mode`, `sandbox`,
`bareMode`) tot nu e accesibil din `doctor`/`run` — orice ajustare fină cere editarea
codului sursă.

**Propunere**: flag-uri CLI suplimentare (sau un fișier de configurare per-repo sub
`.ai-code-worker/`) pentru parametrii de adaptor cei mai des ajustați, astfel încât
folosirea reală a worker-ului să nu ceară recompilare pentru schimbări obișnuite de
configurare.

Închis prin `adapters.codex` / `adapters.claude` în `.ai-code-worker/config.json` și
override-uri CLI pentru model, sandbox, permission mode, bare mode și executabile.

## Faza 3 — itemi amânați intenționat

### 6. Integrarea buclei de repair în fake-run.ts / claude-run.ts / codex-run.ts — done 2026-08-15

Etapa 10 a adăugat opțiunea `independentReview` (hook injectabil: `reviewer` +
`executeRepairCycle`) în toate cele trei runners, prin orchestratorul comun
`src/run/independent-review-repair.ts`. Când `review.status !== "PASS"` și hook-ul e
furnizat, se rulează independent review → ingestie → `compileRepairTasks` →
`runRepairCycles`, cu evenimente `repair.*` proprii, `BLOCKED.md` + repair-evidence la
eșec. Comportamentul existent (block imediat) e neschimbat când hook-ul lipsește — 0
regresii la `claude-run.test.ts`/`codex-run.test.ts` existente.

Dovedit end-to-end cu operații git reale (nu doar mock-uri) în
`tests/unit/fake-run-repair.test.ts`: worktree + commit reale pentru task-ul de repair,
DONE la rezolvare, BLOCKED + repair-evidence.md + BLOCKED.md la epuizare. `BLOCKED.md`
(gol până acum, vezi Etapa 8/9) e scris acum pentru **orice** run blocat, nu doar cel din
repair — `blockRunningRun` a fost extins în toate cele trei runners.

Rămâne deschis, separat: reviewer-ul REAL (care cheamă efectiv Claude/Codex ca să
producă findings genuine dintr-un diff) nu a fost implementat — vezi item 9.

### 7. Teste de recovery pentru repair compilation/execution — done 2026-08-15

Închis odată cu item 6: `tests/unit/fake-run-repair.test.ts` are un test dedicat care
omoară procesul (trunchiere events.jsonl) chiar după ce task-ul original s-a terminat
dar în timpul reparării, apoi reia cu același `--run-id` — confirmă că task-ul original
nu se re-execută (checkpoint) și că repair-ul se recompilează/re-execută curat din
starea recuperată, ajungând la `DONE`.

Testele de redactare pentru „repair prompts" sunt și ele închise:
`src/repair/build-repair-prompt.ts` (`buildRepairPrompt`) construiește textul de prompt
pentru un motor real dintr-un `RepairTask` + findings, cu evidence redactat/plafonat
înainte de a fi inserat — testat în `tests/unit/build-repair-prompt.test.ts`. Rămâne
neconstruit doar apelul REAL către motor cu acest prompt (parte din item 9).

### 8. Bug real găsit și fixat la Etapa 7: worktree-ul de integrare bloca recovery-ul

`createTaskWorktree` (`src/git/worktree.ts`) returna `WORKTREE_PATH_EXISTS` → `BLOCKED`
necondiționat dacă path-ul exista deja. Task-urile au propriul mecanism de recovery
(`continueFromCommittedTask`, pe baza checkpoint-ului de commit), dar worktree-ul de
integrare (`__integration__` în `fake-run.ts`) nu avea niciunul — dacă procesul era
omorât după `git worktree add` pentru integrare dar înainte de `run.done`, reluarea
rămânea permanent `BLOCKED`. Nu exista niciun test care să acopere acest caz.

Închis prin opțiunea `recreateIfExists` pe `createTaskWorktree` (elimină worktree-ul
vechi cu `git worktree remove --force`, cu fallback pe `rm -rf` + `git worktree prune`
dacă nu mai e un worktree valid), folosită **doar** la worktree-ul de integrare — scratch
space fără stare proprie de recuperat, spre deosebire de worktree-urile de task, unde
`recreateIfExists` NU trebuie folosit (le-ar strica recovery-ul bazat pe checkpoint).
Test de regresie în `tests/unit/recovery.test.ts`, verificat explicit că eșuează cu
`BLOCKED` fără fix și trece cu `DONE` cu fix.

### 9. Reviewer-ul independent REAL (apel efectiv la Claude/Codex) — parțial done 2026-08-15

**Ce e acum real**: `src/review/build-review-prompt.ts` (prompt: rol read-only, fără
context conversațional al implementatorului, diff real per task + acceptance criteria,
instrucțiune strictă JSON-only) + `src/review/independent-reviewer-cli.ts`
(`createClaudeIndependentReviewer`/`createCodexIndependentReviewer` — invocare
standalone `spawnSync`, NU prin `ClaudeCliAdapter`/`CodexCliAdapter.start()` pentru că
acelea validează hardcodat contra `agent-result.schema.json`; reutilizează doar
funcțiile de extragere JSON schema-agnostice deja existente, acum exportate:
`candidateAgentResultObjects` din `claude-cli.ts`, `lastAgentMessageText`/
`parseAgentResultText` din `codex-cli.ts`). Read-only real: `--tools/--allowedTools
Read,Grep,Glob` pentru Claude, `--sandbox read-only` pentru Codex. Fail-closed pe
eșec/JSON invalid — verdict `fail` + finding `REV-ENGINE-FAILURE`, niciodată `pass`
silențios (același guardrail ca `unknownUsage()` din #11, aplicat rezultatului de
review). Conectat opt-in prin `--independent-review` în `cli.ts` (doar `--engine
claude|codex`, fără efect implicit — comportament identic fără flag).

**Ce NU e real**: `executeRepairCycle` — execuția efectivă a unui repair task cu un
motor real (dispatch într-un worktree, commit, re-gate) tot nu există.
`src/review/no-repair-capability-executor.ts` e un stand-in documentat: orice task de
repair raportează `FAILED`, review-ul de după ciclu e sintetic ("no repair capability"),
astfel încât bucla se epuizează în bugetul existent și rularea se blochează cu
findings-urile REALE ale reviewer-ului — nu pretinde repair automat care nu există.
Construirea unui `executeRepairCycle` real e un item separat, de mărime comparabilă
(dispatch real de task + worktree + commit + re-gate, reutilizând probabil bucla
per-task deja existentă din `claude-run.ts`/`codex-run.ts`).

22 teste noi (prompt, ambii reviewer prin CLI fals, no-repair-executor, end-to-end prin
`runFake` — review structural eșuează → reviewer real (CLI fals) → repair epuizat →
BLOCKED cu finding-ul real). 310/310 teste, phase0/phase2 demo PASS, zero regresii.
~93.4k tokeni (checkpoint auto-tracked, vezi `docs/BENCHMARKS.md`).

### 10. Codex CLI — găsit și verificat real cu adaptorul — done 2026-08-15

`codex` nu era pe `PATH` global, dar exista pe mașină: binarul e livrat în interiorul
extensiei VS Code `openai.chatgpt` (nu ca CLI global instalat separat), la
`<vscode-extensions>\openai.chatgpt-<versiune>-win32-x64\bin\windows-x86_64\codex.exe`
— `codex-cli 0.148.0-alpha.9`.

`doctor --engine codex --codex-executable <cale>` inițial bloca cu
`CODEX_VERSION_UNTESTED` (0.148.0-alpha.9 nu era în `testedVersionRanges` implicit din
`src/doctor/doctor.ts`, care listează doar 0.146.0-alpha.3.1 și 0.136.0-alpha.2,
verificate cu note comportamentale specifice fiecăreia). Nu am modificat lista implicită
(ar cere verificarea comportamentală profundă pe care intrările existente o documentează,
nu doar un smoke test) — am folosit un override `adapters.codex.testedVersionRanges` în
`.ai-code-worker/config.json` al unui fixture izolat, temporar, doar pentru validare.

Cu override: `doctor --engine codex` → PASS (smoke test + behavioral smoke test PASS).
`run --engine codex` pe un fixture cu un singur task trivial → **DONE**, commit real,
gate real trecut. Fixture-ul temporar a fost șters după validare.

Nivel de verificare: doar smoke-test + o rulare minimă reală, **nu** verificarea
comportamentală profundă (sandbox modes, auth modes) pe care intrările din
`testedVersionRanges` implicit o reprezintă pentru versiunile deja listate — dacă se
decide adoptarea 0.148.0-alpha.9 ca versiune implicit suportată, acea verificare
rămâne de făcut separat, cu aceleași note de tip „verificat live pe machineX/dată" ca
la 0.136.0-alpha.2.

### 11. `unknownUsage()` hardcodat în ambele adaptoare reale — done 2026-08-15

Găsit prin `docs/HANDOFF-BENCHMARK-TOOL-AND-PHASE-4.md` (Partea A, item 3): atât
`claude-cli.ts` cât și `codex-cli.ts` întorceau `usage: unknownUsage()` pe orice cale
de succes a `start()`/`startAsync()`, deși ambele CLI-uri reale returnează deja
token/cost accounting real (`--output-format json` la Claude, `--json` la Codex) —
niciodată parsat. Orice `evidence.json`/`run-report.json` pentru motoare reale arăta
`usageTotals` complet `null`.

Închis prin `parseClaudeUsage()`/`parseCodexUsage()`: Claude citește obiectul top-level
`usage` (`input_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens`/
`output_tokens`) și `total_cost_usd` din envelope-ul `--output-format json`; Codex
scanează stream-ul `--json` pentru ultimul eveniment `event_msg`/`token_count` (
`total_token_usage` e deja cumulativ per invocare, deci nu se sumează peste evenimente)
și scade `cached_input_tokens` din `input_tokens` pentru partea necache-uită (convenție
OpenAI Responses API — subset, nu sumă suplimentară). Codex nu expune cache-write sau
cost în `$`, doar un procent de rate-limit (altă unitate) — acele câmpuri rămân `null`,
nu ghicite.

Testat cu fixture-uri care reproduc formele reale capturate în handoff (
`tests/fixtures/engine-usage/`), nu prin apeluri CLI live în teste — 226/226 teste,
phase0/phase2 demo PASS, zero regresii. Nu s-a atins `run/claude-run.ts`/
`run/codex-run.ts`: `execution.usage` era deja cablat spre `evidenceFor`/`addUsage`,
deci datele reale curg automat odată ce adaptorul le produce.

### 12. Tool de usage benchmark (`src/benchmark/`) — done 2026-08-15

Restul Părții A din `docs/HANDOFF-BENCHMARK-TOOL-AND-PHASE-4.md` (etapele 2-6),
implementat integral în aceeași sesiune cu itemul #11:

- **Cititoare de sesiune locale** (`read-claude-session.ts`, `read-codex-session.ts`):
  funcții pure peste conținut de fișier + un wrapper fs best-effort (`null` la fișier
  lipsă/corupt, niciodată throw) — tratează `~/.claude/projects/...` și
  `~/.codex/sessions/...` ca sursă read-only, în afara repo-ului și `$STATE_ROOT`, per
  guardrail-ul din handoff. `findClaudeSessionLogPath` scanează după `sessionId` în loc
  să recalculeze algoritmul de hash de proiect (nedocumentat); `findLatestCodexRolloutPath`
  ia cel mai recent `rollout-*.jsonl` din arbore.
- **Schema + store checkpoint** (`schemas/usage-checkpoint.schema.json`,
  `usage-checkpoint.ts`): `UsageCheckpointLog` JSONL append-only, aceeași formă/toleranță
  la coadă trunchiată ca `EventLog`, dar fără invariantul de secvență strict (nu e stream
  critic pentru recovery). Stocat sub `<stateRoot>/benchmarks/usage-checkpoints.jsonl` —
  cross-run, lângă `runs/`, nu per-run — pentru ca estimatorul să vadă istoricul complet.
  Cablat la nivel de task (start/end, `EngineUsage` real din #11) în toate cele trei
  runners, la SINGURUL punct de inserție relevant (`adapter.start()`/`engine.start()`),
  nu în cele 10+ căi `BLOCKED` cu return timpuriu din fiecare fișier — aditiv, fără
  chirurgie pe state machine (aceeași precauție ca la Faza 4 în handoff). `RunManifestTask`
  extins cu `kind`/`risk` (tip, nu date noi — câmpurile există deja în manifest.json).
- **Calibrare Claude** (`claude-calibration.ts`): raport tokeni/punct-procentual, mediana
  peste cele 6 perechi reale (context Δ, %5h Δ) deja în `docs/BENCHMARKS.md` (Etapele 3-8
  Faza 3) — nu există alt semnal local pentru %5h/%săpt (confirmat live, vezi handoff).
- **Estimator** (`estimate.ts`): bucket pe `kind:risk`, mediană/min/max peste eșantioane
  istorice reale din checkpoint log; task fără istoric → `tokens: null` + apare explicit
  în `tasksWithoutHistory`, niciodată asumat 0.
- **CLI** (`run --engine <fake|claude|codex>`): printează estimarea pre-run (opt-out cu
  `--no-estimate`; în mod uman apare înaintea rulării, în `--json` e pliată în același
  obiect final ca să rămână un singur JSON valid pe stdout — a fost nevoie de fix după ce
  primul draft rupea un test CLI existent care aștepta exact un obiect JSON pe stdout).
  Checkpoint de run (start înainte de dispatch, end după ce `runFake`/`runClaude`/
  `runCodex` returnează) — folosește `report.usageTotals` real, cross-check best-effort
  cu ultimul rollout Codex local pentru `codex`, `percentUsedEstimated` via calibrare
  doar pentru `claude` (niciodată conflat cu `percentUsedReported`, care rămâne `null`
  fără o citire reală).

Verificat manual end-to-end (nu doar teste): rulare 1 pe un fixture proaspăt →
"no historical data"; rulare 2 pe ACELAȘI repo → estimare reală derivată din checkpoint-
urile rulării 1, inclusiv %5h calibrat; `--json --no-estimate` → un singur obiect JSON
valid, fără cheia `preRunEstimate`.

254/254 teste (226 + 28 noi: cititoare de sesiune, checkpoint store, calibrare,
estimator), phase0/phase2 demo PASS, zero regresii.

### 13. Decizia canalului stabil de distribuție (npm/executable semnat/submodule/CLI extern) — decis 2026-08-15 (submodule), config rămâne de implementat

Etapele 1-7 din Faza 4/Part B (`docs/HANDOFF-BENCHMARK-TOOL-AND-PHASE-4.md`) au fost
implementate 2026-08-15: provider `ai-code-control` skeleton, wiring health/brief/
refresh, export handoff redactat, `init`/`update` cu blocuri versionate, onboarding
submodule + upgrade, matrice compatibilitate Codex/Claude, shims opționale Codex/Claude.

Etapa 8 (ultima) e explicit marcată în plan ca "Decizie + config, nu cod greu — necesită
input de la user, nu doar implementare". Nu poate fi luată unilateral: schimbă cum se
instalează și se actualizează worker-ul în orice repository consumator, iar o revenire
ulterioară ar cere migrarea repo-urilor deja onboardate — genul de decizie ireversibilă
pe care acest proiect o rezervă userului, nu agentului.

**Propunere**: `docs/DISTRIBUTION.md` (scris 2026-08-15) detaliază cele 4 opțiuni (npm
package, executable semnat, submodule/Git dependency — canalul de facto folosit azi de
Etapele 1-7 —, CLI extern + config versionat) cu trade-off-uri concrete, inclusiv o
constrângere reală descoperită prin construirea etapelor anterioare: `SchemaRegistry`,
`installShims()` și exportul de handoff citesc `schemas/`/`templates/` relativ la
rădăcina repository-ului la runtime, nu din bundle — asta afectează diferit fiecare
opțiune (cost zero pentru submodule/CLI extern, cost real de repackaging pentru npm/
executable). Următorul pas e alegerea userului, apoi implementarea config-ului aferent
(mic, per document).

**Update 2026-08-15**: userul a confirmat submodule ca și canal — dar în contextul mai
larg al `docs/INFOAPEX-AI-VISION.md`: `ai-code-worker` va fi unul din cinci repo-uri
independente (worker/control/architect/review/docs) legate de un installer umbrelă
separat (`infoapex-ai`). Config-ul mic rămas de implementat aici (ex. verificare
versiune worker vs. schemaVersion config, dacă mai e nevoie) ar trebui reevaluat după ce
forma installer-ului umbrelă e mai clară — posibil să fie subsumat de installer, nu
implementat separat în worker.

### 14. Detecție dinamică de versiune Claude/Codex (nu listă hardcodată) — neimplementat, așteaptă forma installer-ului din infoapex-ai

Legat de Etapa 6 (matrice compatibilitate, `todo.md` context) și de descoperirea live
2026-08-15 că `codex-cli 0.148.0-alpha.9` există deja local (livrat cu extensia VS Code
`openai.chatgpt`), dar e respins azi de `testedVersionRanges` hardcodat din
`defaultCodexConfig()`/`defaultClaudeConfig()` (`src/doctor/doctor.ts`).

**Decizie arhitecturală confirmată de user**: nu se mai stabilește o versiune exactă
hardcodată. `ai-code-worker` trebuie să identifice dinamic instalările locale de
Claude/Codex (PATH + locații cunoscute, ex. extensii VS Code) și să urmărească automat
actualizările lor. Propunerea agentului, acceptată: smoke test-ul comportamental deja
existent (verifică live flag-uri + comportament necesar) devine gate-ul principal de
siguranță, nu un string de versiune dintr-o listă — fail-closed rămâne intact (o
versiune care nu trece smoke test-ul tot BLOCKED), doar mecanismul de verificare
devine dinamic în loc de static.

**De ce e amânat, nu implementat direct**: userul a legat explicit acest item de
installer-ul din punctul C (`docs/INFOAPEX-AI-VISION.md`) — "probabil printr-un fișier
de init-config al installer-ului îi spunem ce LLM-uri folosim și cum le folosim", nu
doar o schimbare izolată în `ai-code-worker`. Forma exactă a acelui config (cine îl
scrie, unde stă, cum îl citește worker-ul) nu e clarificată încă. Implementarea aici
riscă să fie refăcută odată ce installer-ul e proiectat — se așteaptă clarificare.
