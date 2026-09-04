# Plan de implementare `ai-code-benchmark` — P4.5 / BENCH

Status: **acceptat ca prerechizită pentru continuarea P5; implementarea nu a început**  
Data: **2026-09-03**  
Repository canonic propus: `Infoapex/ai-code-benchmark`  
Integrare în bundle: al șaselea modul din `Infoapex/infoapex-ai`  
Principiu: benchmark-ul evaluează Infoapex AI din exterior; nu importă logica internă a
modulelor evaluate și nu acceptă verdictul autoraportat al unui agent drept dovadă.

## 1. Decizie și poziționare în roadmap

`ai-code-benchmark` devine etapa **P4.5 / BENCH**, executată după CLI-ul root P4 și
înaintea continuării funcționale a P5.

Primul subproiect P5, OpenTelemetry redactat, este deja implementat. El nu este anulat și
nu se rescrie retroactiv; devine primul candidat P5 evaluat retrospectiv de benchmark.
Niciun alt subproiect P5 nu intră în implementare înainte ca BENCH-00–BENCH-10 să treacă
și să existe un baseline live publicat intern.

P4.5 nu înlocuiește testele, gate-urile sau pilotul P2. Rolurile sunt diferite:

- testele demonstrează că implementarea respectă contractele;
- gate-urile demonstrează că un flux determinist funcționează;
- P2 demonstrează că providerii reali pot executa taskuri bounded;
- `ai-code-benchmark` măsoară dacă Infoapex AI produce valoare față de alternative,
  cât costă acea valoare și dacă o schimbare P5 o îmbunătățește sau o degradează.

## 2. Obiective

Modulul trebuie să ofere un cadru reproductibil pentru:

1. compararea folosirii directe a Codex/Claude cu folosirea orchestrată prin Infoapex AI;
2. izolarea contribuției ICM + Graph față de orchestration-only;
3. compararea unei versiuni baseline cu o schimbare candidată, inclusiv fiecare subproiect P5;
4. măsurarea separată a calității, siguranței, efortului uman, latenței și consumului;
5. reluarea unui experiment întrerupt fără dublarea observațiilor;
6. publicarea unui raport verificabil, cu configurația, inputurile și limitările înghețate;
7. păstrarea funcționării standalone a fiecărui modul Infoapex.

## 3. Non-obiective

Prima versiune nu:

- produce un clasament universal al modelelor;
- declară un singur „scor Infoapex” care ascunde compromisurile;
- estimează câmpuri necunoscute ca `0`;
- folosește răspunsul agentului ca unic verdict de corectitudine;
- copiază loguri brute de sesiune, prompturi, secrete sau conținut proprietar în raport;
- modifică automat codul produsului ca să facă un braț să treacă;
- rulează experimente live fără autorizare explicită și buget înghețat;
- compară modele, effort-uri sau sandbox-uri diferite ca și cum ar fi același braț;
- activează `GRAPH-06` implicit.

## 4. Principii metodologice obligatorii

### 4.1 Evaluator independent

`ai-code-benchmark` comunică cu Codex, Claude și Infoapex AI exclusiv prin procese și
artefacte versionate. Nu importă `src/` din planner, worker, review, docs sau control.
Un defect în modulul evaluat nu trebuie să poată altera evaluatorul sau verdictul.

### 4.2 Experiment preregistrat și imuabil

Înainte de prima invocare live se îngheață:

- dataset-ul și hash-ul fiecărui task;
- repository-ul și commitul inițial;
- brațele și ordinea lor;
- providerul, modelul, effort-ul, versiunea CLI/SDK și argumentele;
- permisiunile, sandbox-ul și tool-urile disponibile;
- configurațiile Infoapex și pinurile modulelor;
- comenzile de verificare și oracolele;
- metricile primare, pragurile și regulile pentru date lipsă;
- numărul maxim de invocări, durata și bugetul de cotă.

După `experiment.started`, schimbarea oricăruia dintre aceste câmpuri produce un nou
`experimentId`; nu rescrie experimentul existent.

### 4.3 Comparație paired, nu taskuri diferite pe brațe

Același task pornește din același commit și este executat în fiecare braț. Compararea
între taskuri diferite este descriptivă, nu dovadă de efect.

### 4.4 Corectitudine externă agentului

Verdictul se bazează, în această ordine, pe:

1. comenzi deterministe de build/test/lint/security;
2. oracole specifice taskului: invariants, fișiere așteptate, API behavior, snapshot sau
   mutation tests;
3. verificarea scope-ului și a diff-ului;
4. reviewer blind, fără contextul implementatorului, numai pentru criterii care nu pot fi
   automatizate;
5. adjudecare umană documentată pentru rezultate ambigue.

Reviewer-ul LLM nu poate transforma singur un gate determinist eșuat în `PASS`.

### 4.5 Metrici separate

Raportul nu reduce calitatea, timpul, tokenii și siguranța la o singură valoare. O
îmbunătățire de cost nu poate ascunde o regresie de corectitudine sau o încălcare de scope.

## 5. Brațele standard

### A — `direct`

Codex sau Claude este invocat direct, fără planner, worker, review, docs sau control.
Adaptorul primește aceeași cerință, același repository de pornire și aceleași permisiuni
care pot fi oferite legitim și celorlalte brațe.

### B — `orchestrated-no-icm`

Taskul rulează prin planner/worker și gate-urile de bază, dar fără context enforcement,
trace-graph augmentation și reutilizarea ICM. Dezactivarea trebuie făcută prin contracte
publice și versionate; sunt interzise patch-uri private sau bypass-uri ascunse folosite
numai de benchmark.

BENCH-00 trebuie să confirme că acest braț poate fi exprimat prin configurația curentă.
Dacă nu poate, se adaugă întâi un mod explicit `observe/off` în contractul relevant,
cu teste proprii. Până atunci brațul este `UNSUPPORTED`, nu simulat.

### C — `full-icm`

Fluxul Infoapex complet: planner, worker, context/ICM, Graph unde taskul îl justifică,
gate-uri, repair bounded, review independent și evidence.

### D — `candidate`

Braț opțional pentru o schimbare P5. Este identic cu C, cu excepția unei singure
capabilități candidate. Dacă sunt schimbate două capabilități, se creează două
experimente sau un design factorial preregistrat explicit.

### Reguli provider

- Codex și Claude se evaluează în experimente separate sau ca factor declarat;
- nu se agregă automat rezultate de la modele/effort-uri diferite;
- schimbarea providerului în urma unui fallback rămâne vizibilă și nu este atribuită
  providerului cerut;
- cross-review-ul este un cost și o invocare separată;
- rulările `fake` validează harness-ul, nu intră în verdictul de valoare.

## 6. Dataset-ul benchmark

### 6.1 Două clase de suite

1. **Generică și distribuibilă** — repository-uri fixture fără date proprietare, pentru
   CI, regresii și reproducere publică/internă.
2. **Consumer real, privat** — taskuri extrase din proiecte reale; în repository-ul
   benchmark se păstrează doar metadate redactate și hash-uri dacă inputul nu poate fi
   distribuit.

### 6.2 Categorii minime

- modificare mecanică locală;
- bug fix cu test de regresie;
- schimbare cross-file;
- schimbare de contract/API;
- refactor cu păstrarea comportamentului;
- documentație sincronizată cu codul;
- schimbare cu risc de scope;
- task cu dependențe în DAG;
- task care necesită recovery;
- task negativ/imposibil, unde comportamentul corect este `BLOCKED`.

Fiecare task declară `kind`, `risk`, limbajele, dimensiunea repository-ului, dificultatea
estimată înainte de rulare și motivul includerii. Dificultatea nu se recalculează după
observarea rezultatelor.

### 6.3 Cerințe pentru un task

Un `benchmark-task` conține:

- ID stabil și versiune;
- prompt canonic sau referință privată + SHA-256;
- commit/artefact inițial;
- setup determinist;
- allowlist și denylist de paths;
- criterii de acceptare;
- comenzi de verificare bounded;
- oracle și expected outcome;
- limită de timp/output;
- reguli de cleanup;
- clasificarea datelor și politica de publicare.

Soluția de referință și expected diff nu sunt accesibile procesului agent. Ele intră în
mediul evaluatorului numai după terminarea brațului.

## 7. Design experimental

### 7.1 Niveluri de execuție

| Nivel | Scop | Dataset | Repetări | Invocări orientative |
|---|---|---:|---:|---:|
| BENCH-D | harness determinist | 12 taskuri, motoare fake | 1 | 0 live |
| BENCH-P | pilot live bounded | 10 taskuri × 3 brațe | 1/provider | 30/provider |
| BENCH-A | baseline autoritativ | minimum 30 taskuri × 3 brațe | 3 | 270/provider |

BENCH-A pornește numai după analiza pilotului și o estimare explicită de cotă. Numărul
final de taskuri poate fi schimbat înaintea preregistrării pe baza variance/power
analysis; nu se oprește anticipat doar pentru că rezultatul intermediar este favorabil.

### 7.2 Ordinea rulărilor

- ordinea brațelor este balansată per task printr-un seed salvat;
- rulările nu împart worktree, state root sau artefacte de context;
- cold-cache și warm-cache sunt cohorte distincte;
- execuția paralelă este permisă numai între conturi/mașini izolate; altfel poate altera
  quota și cache-ul;
- aceeași versiune de OS/toolchain este folosită în interiorul unui experiment;
- ora, regiunea și starea providerului se înregistrează pentru interpretare.

### 7.3 Date lipsă și eșecuri

- `null` înseamnă necunoscut; nu devine `0`;
- provider outage, quota, sandbox, policy și defect de implementare sunt clase distincte;
- un braț fără telemetrie completă poate primi verdict funcțional, dar comparația
  economică devine `INCONCLUSIVE`;
- timeout-ul rămâne rezultat al brațului, nu este șters prin rerun; rerun-ul este o
  observație separată;
- experimentul păstrează toate observațiile valide, inclusiv eșecurile.

## 8. Metrici și formule

### 8.1 Metrici primare

1. **Verified task success**  
   `taskuri cu toate criteriile și gate-urile trecute / taskuri eligibile`.
2. **First-pass success**  
   succes înainte de retry, repair sau intervenție umană.
3. **Scope safety**  
   număr și severitate de modificări/acțiuni în afara autorizării.
4. **Human active minutes**  
   timp activ pentru pregătire, intervenție, review și corecții post-run, raportat
   separat de timpul de așteptare.

### 8.2 Metrici secundare

- retries, repair cycles și fallback-uri;
- defecte găsite de review și defecte scăpate;
- precision/recall pe suite cu defecte injectate controlat;
- latență totală, mediană și p90/p95;
- input uncached, cache read, cache write și output tokens;
- total tokens numai când toate componentele sunt cunoscute;
- procent 5h măsurat/estimat, cu sursa și limitările sale;
- cost USD numai unde providerul îl raportează real;
- număr de invocări și succes per invocare;
- dimensiunea diff-ului și fișiere schimbate;
- evidence coverage și trace coverage;
- succes recovery și cleanup;
- overhead-ul harness-ului în afara timpului providerului.

### 8.3 Statistică

- comparațiile sunt paired per `taskId` și repetition seed;
- ratele binare raportează interval de încredere Wilson sau bootstrap paired;
- valorile skewed raportează mediană, IQR și p90, nu doar medie;
- se raportează efectul absolut și relativ;
- p-value nu este folosit singur ca verdict;
- outlier-ele nu se elimină fără regula preregistrată;
- rezultatele per categorie/risc/provider preced agregatul global.

### 8.4 Praguri implicite propuse

Suitele pot declara praguri mai stricte. Pentru baseline-ul inițial:

- C este non-inferior față de A la verified success, cu marjă maximă de 5 puncte
  procentuale;
- C nu introduce nicio încălcare critică de scope/securitate;
- minimum 95% dintre observații au telemetria obligatorie completă sau o explicație
  structurată pentru lipsă;
- C trebuie să arate cel puțin un câștig preregistrat: reducere de minimum 20% a timpului
  uman activ, creștere de minimum 10 puncte a first-pass success sau creștere de minimum
  25% a defectelor relevante detectate înainte de acceptare;
- orice regresie semnificativă de calitate/siguranță produce `REJECT`, indiferent de cost.

Pentru BENCH-P pragurile sunt direcționale, deoarece eșantionul este mic. Numai BENCH-A
poate susține afirmații generale de produs.

## 9. Evaluarea schimbărilor P5

Fiecare subproiect P5 adaugă un manifest `candidate-hypothesis` cu:

- o singură schimbare evaluată;
- metricile care ar trebui să se îmbunătățească;
- metricile care nu au voie să regreseze;
- dataset-ul relevant;
- pragurile de acceptare;
- costul maxim al experimentului;
- decizia posibilă: `ACCEPT`, `REJECT`, `INCONCLUSIVE` sau `ACCEPT_WITH_LIMITS`.

Exemple:

| Subproiect P5 | Ipoteză măsurabilă |
|---|---|
| OpenTelemetry redactat | zero leakage, overhead harness sub 5%, trace complet pentru minimum 95% din evenimentele eligibile |
| UI local | reducere a timpului de diagnostic și review uman fără schimbarea verdictului |
| Provider registry | adaptor nou fără regresie de contract sau fallback ascuns |
| SDK adapters | latență/recovery/telemetrie mai bune decât adaptorul CLI, la aceeași calitate |
| Draft PR | zero publicări fără autorizare; timp redus până la artefactul reviewable |
| Backend remote/CI | izolare și cleanup mai bune, fără regresie funcțională peste prag |
| Signing/SBOM | verificare supply-chain reproductibilă, fără artefacte neverificabile |
| GRAPH-06 | recall de review mai bun suficient pentru costul și latența suplimentare |

OpenTelemetry, deja implementat, este evaluat printr-un experiment baseline-vs-candidate
construit după finalizarea harness-ului; raportul trebuie să precizeze că ipoteza nu a
fost preregistrată înaintea implementării și are valoare de validare retrospectivă.

## 10. Arhitectura modulului

```text
modules/ai-code-benchmark/
├── src/
│   ├── cli.ts
│   ├── contracts/
│   ├── dataset/
│   ├── experiment/
│   ├── adapters/
│   │   ├── direct-codex.ts
│   │   ├── direct-claude.ts
│   │   ├── infoapex-root.ts
│   │   └── fake.ts
│   ├── isolation/
│   ├── execution/
│   ├── evidence/
│   ├── evaluation/
│   ├── metrics/
│   ├── statistics/
│   ├── report/
│   ├── security/
│   └── persistence/
├── schemas/
├── datasets/
│   ├── generic-v1/
│   └── private-manifests/
├── templates/
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── security/
│   ├── recovery/
│   └── e2e/
├── docs/
├── package.json
├── README.md
└── LICENSE
```

Modulul este TypeScript/Node 22, în linie cu planner/worker/review/docs. Tooling-ul
statistic trebuie să fie determinist și local; nu se introduce un serviciu remote în v1.

## 11. Contracte versionate

Minimum următoarele JSON Schemas:

1. `benchmark-suite.schema.json` — dataset, brațe, metrici, praguri și bugete;
2. `benchmark-task.schema.json` — task, setup, oracle, scope și verificări;
3. `benchmark-environment.schema.json` — OS, toolchain, hardware relevant, CLI-uri,
   module pins și configurații redactate;
4. `benchmark-experiment.schema.json` — snapshotul preregistrat și hash-ul său;
5. `benchmark-observation.schema.json` — o execuție task × arm × repetition;
6. `benchmark-intervention.schema.json` — log append-only al intervențiilor umane;
7. `benchmark-evaluation.schema.json` — rezultate de gate/oracle/reviewer;
8. `benchmark-report.schema.json` — agregate, intervale, verdict și limitări;
9. `candidate-hypothesis.schema.json` — gate-ul unei schimbări P5;
10. `benchmark-event.schema.json` — event log pentru recovery.

Toate folosesc `additionalProperties: false`, semantică explicită pentru `null`, enums
versionate și validare la fiecare boundary. Hash-ul experimentului este inclus în fiecare
observation/evaluation/report.

## 12. Persistență și recovery

```text
<stateRoot>/benchmarks/<experimentId>/
├── experiment.json
├── environment.json
├── events.jsonl
├── observations/
│   └── <taskId>/<armId>/<repetition>.json
├── evidence/
├── interventions.jsonl
├── evaluations/
├── aggregates.json
├── REPORT.md
└── COMPLETE.json | BLOCKED.json
```

Reguli:

- event log append-only, tolerant numai la ultima linie trunchiată;
- cheie idempotentă: `experimentHash/taskId/armId/repetition`;
- o observație completă nu se reexecută la `resume`;
- un proces omorât după execuție, dar înainte de agregare, reia evaluarea din evidence;
- artefactele unui braț nu sunt vizibile altui braț;
- cleanup-ul nu șterge evidence înainte de finalizarea raportului;
- mutarea experimentului pe altă mașină păstrează căi relative în rapoarte.

## 13. CLI propus

```text
ai-code-benchmark init --repo <path>
ai-code-benchmark validate --suite <suite.json>
ai-code-benchmark doctor --suite <suite.json>
ai-code-benchmark freeze --suite <suite.json> --out <experiment.json>
ai-code-benchmark run --experiment <experiment.json> --mode deterministic
ai-code-benchmark run --experiment <experiment.json> --live --authorization <file>
ai-code-benchmark resume --experiment-id <id>
ai-code-benchmark evaluate --experiment-id <id>
ai-code-benchmark report --experiment-id <id> --format json|markdown
ai-code-benchmark compare --baseline <id> --candidate <id>
```

În bundle se adaugă:

```text
infoapex-ai benchmark <subcommand> [...args]
```

CLI-ul root deleagă prin subprocess conform ADR-0003 și nu reimplementează benchmark-ul.

Exit codes minime:

- `0`: comandă executată și verdict valid;
- `2`: input/config/schema invalidă;
- `3`: experiment blocat de provider/quota/infrastructură;
- `4`: rezultat comparativ `REJECT`;
- `5`: rezultat `INCONCLUSIVE`;
- `6`: policy/security violation.

## 14. Securitate și confidențialitate

- autorizare separată pentru orice run live;
- `maximumInvocations`, `maximumMinutes` și budget quota obligatorii;
- environment allowlist, niciodată dump complet de env;
- stdout/stderr bounded și redactat înainte de persistare;
- logurile locale Codex/Claude sunt citite read-only și nu sunt copiate integral;
- prompturile private rămân în dataset-ul privat; raportul folosește ID + hash;
- paths absolute și usernames nu apar în raportul distribuibil;
- fiecare braț rulează într-o copie/worktree izolată;
- executarea comenzilor de verificare folosește allowlist și timeout;
- symlink/junction/path traversal testate negativ;
- nicio publicare Git/PR și nicio rețea suplimentară fără capabilitate explicită;
- raportul păstrează provenance pentru evaluator și toate modulele evaluate.

## 15. Plan de implementare

### BENCH-00 — ADR, threat model și feasibility spike

**Scop:** înghețarea boundary-ului și verificarea brațelor A/B/C fără a construi runtime.

Livrabile:

- ADR pentru evaluator independent și subprocess boundary;
- threat model;
- inventarul metricilor deja disponibile;
- verificarea modului `orchestrated-no-icm`;
- decizie asupra state root și a dataseturilor private;
- trei spike-uri read-only: direct Codex, direct Claude, Infoapex root.

Gate:

- nicio metrică primară nu depinde exclusiv de self-report;
- brațele sunt realizabile sau limitarea `UNSUPPORTED` este documentată;
- se aprobă explicit bugetul pilotului.

### BENCH-01 — Repository standalone și skeleton

Livrabile:

- repository `Infoapex/ai-code-benchmark`;
- package, CLI, config loader, schema registry, JSON output și help;
- CI Windows/Linux;
- licență și reguli de provenance.

Gate: clean clone → `npm ci` → build → test.

### BENCH-02 — Contracte și dataset loader

Livrabile:

- cele 10 scheme v1;
- loader fail-closed;
- hash canonic pentru suite/task/experiment;
- dataset generic v1 cu 12 taskuri și oracole ascunse agentului.

Gate: fixtures valide/invalide, unknown-property rejection și hash stabil cross-platform.

### BENCH-03 — Adaptoare de braț

Livrabile:

- direct Codex;
- direct Claude;
- Infoapex root pentru B/C/D;
- fake adapters pentru CI;
- captură normalizată a versiunii, modelului, effort-ului și permisiunilor.

Gate: contract tests și fake CLI E2E pentru fiecare adaptor.

### BENCH-04 — Izolare, scheduler și recovery

Livrabile:

- clone/worktree per observation;
- seed și ordine balansată;
- event log append-only;
- timeout, cancellation, resume și cleanup;
- prevenirea contaminării între brațe.

Gate: kill/restart în fiecare punct critic fără dublarea observațiilor.

### BENCH-05 — Colectarea metricilor

Livrabile:

- usage normalizat prin parsere versionate;
- latență separată provider/harness;
- diff/scope/evidence metrics;
- intervention log manual și import validat;
- completeness per metrică.

Gate: cumulative/incremental/resume nu dublează tokenii; necunoscut rămâne `null`.

### BENCH-06 — Evaluator independent

Livrabile:

- runner pentru gate-uri și oracole;
- scope validator;
- mutation fixtures pentru precision/recall;
- reviewer blind opțional;
- adjudecare și audit trail.

Gate: un agent care declară fals `DONE` nu poate obține `PASS`.

### BENCH-07 — Agregare, statistică și rapoarte

Livrabile:

- paired comparisons;
- intervale de încredere și distribuții;
- raport JSON + Markdown;
- verdict per metrică și per categorie;
- `ACCEPT/REJECT/INCONCLUSIVE/ACCEPT_WITH_LIMITS` pentru candidate P5.

Gate: golden reports stabile pe Windows/Linux și zero scor compozit ascuns.

### BENCH-08 — Harness determinist BENCH-D

Livrabile:

- 12 taskuri × A/B/C cu fake adapters;
- scenarii de success, failure, timeout, quota, scope violation și recovery;
- security/redaction suite;
- integrare completă în CI fără consum de provider.

Gate: toate observațiile sunt reproductibile și toate defectele injectate sunt clasificate
corect.

### BENCH-09 — Pilot live BENCH-P

Livrabile:

- 10 taskuri reale și reprezentative;
- experiment separat Codex și Claude sau justificarea providerului ales;
- 30 de invocări maxime per provider pentru A/B/C;
- log al intervențiilor umane;
- raport intern și decizie asupra BENCH-A.

Gate: minimum 90% observations cu verdict valid, fără încălcări critice, configurație
înghețată și limitări explicite. Un pilot inconclusive nu este cosmetizat în PASS.

### BENCH-10 — Integrare în bundle și baseline P5

Livrabile:

- pin în `modules/provenance.json`;
- `setup`, `build`, `test` și release smoke extinse la al șaselea modul;
- registry P4 și `infoapex-ai benchmark`;
- documentație root;
- baseline versionat;
- evaluare retrospectivă OpenTelemetry;
- template obligatoriu pentru toate subproiectele P5 viitoare.

Gate: clean ZIP pe Windows/Linux și reproducerea raportului deterministic din bundle.

## 16. Strategia de testare

Minimum:

- unit tests pentru canonical hashing, agregare, statistică și redaction;
- contract tests pentru toate schemele și adaptoarele;
- negative security tests pentru paths, env, secrets și command injection;
- recovery tests prin trunchiere/kill în execuție, evaluare și raportare;
- fake CLI E2E pentru Codex, Claude și Infoapex;
- cross-platform path tests, inclusiv aliasuri Windows;
- reproducibility tests pentru seed și ordinea brațelor;
- regression tests pentru cumulative usage și session lookup;
- golden report tests cu toleranță numai pentru câmpurile volatile declarate;
- live tests exclusiv manual/workflow-dispatch, niciodată pe PR implicit.

## 17. Integrare CI și release

CI standard:

1. build + unit/contract/security/recovery;
2. schema/fixture validation;
3. BENCH-D A/B/C cu fake adapters;
4. generic boundary și provenance;
5. bundle release smoke test.

CI nu primește credențiale de provider pentru pull requests. Pilotul live rulează numai
prin workflow protejat, cu environment approval, limită de invocări și artefacte
redactate. Rapoartele live nu sunt publicate automat dacă dataset-ul este privat.

## 18. Modele de lucru recomandate

| Etapă | Model | Efort | Rol |
|---|---|---|---|
| BENCH-00 | Sol | high/xhigh | metodologie, boundary, threat model și bias review |
| BENCH-01–05 | Terra | high | contracte, CLI, adapters, persistence și metrici |
| BENCH-02/08 fixtures | Luna | medium | fixtures repetitive, urmate de validare independentă |
| BENCH-06–07 | Sol + Terra | high | evaluator și statistică; implementare verificabilă |
| BENCH-09 | Sol | high | preregistrare și interpretarea pilotului live |
| BENCH-10 | Terra + Sol review | high | bundle integration și release gate |

Modelul care implementează o schimbare nu este autoritatea unică asupra evaluării ei.

## 19. Gate final P4.5

P4.5 este închis numai dacă:

- modulul funcționează standalone și din bundle;
- A/B/C sunt implementate prin contracte publice, fără bypass ascuns;
- dataset-ul generic și oracolele sunt versionate;
- BENCH-D trece integral pe Windows și Linux;
- recovery-ul nu dublează observații sau usage;
- rapoartele separă calitatea, siguranța, timpul, efortul uman și consumul;
- datele lipsă produc `INCONCLUSIVE`, nu valori inventate;
- există minimum un BENCH-P live complet și auditabil;
- benchmark-ul însuși are threat model, teste negative și provenance;
- OpenTelemetry este evaluat retrospectiv;
- fiecare subproiect P5 are template de hypothesis + baseline + candidate + verdict.

## 20. Ordinea imediată recomandată

1. Oprirea extinderii P5 după OpenTelemetry.
2. BENCH-00: ADR, threat model și verificarea brațului B.
3. BENCH-01–03: skeleton, contracte, dataset și adapters.
4. BENCH-04–07: runtime, recovery, evaluator, metrici și raportare.
5. BENCH-08: validare deterministă completă.
6. Review independent al metodologiei înainte de consum live.
7. BENCH-09: pilot live bounded.
8. BENCH-10: standalone publication, pin în bundle și evaluarea OpenTelemetry.
9. Reluarea P5, câte un subproiect, fiecare cu experiment candidate propriu.

Acest plan transformă benchmark-ul dintr-un script punctual într-un control de produs:
Infoapex AI nu va afirma că o funcționalitate P5 aduce valoare doar pentru că este
implementată și testată, ci numai după ce efectul ei este măsurat față de un baseline
înghețat și verificat independent.
