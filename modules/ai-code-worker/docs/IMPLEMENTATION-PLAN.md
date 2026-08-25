# ai-code-worker — plan de implementare

- Versiune: 1.2
- Status: acceptat ca bază de implementare în repository-ul independent
- Data inițială: 2026-07-31
- Amendat: 2026-08-01
- Owner: developer experience
- Nume produs/CLI: `ai-code-worker`
- Director de configurare în proiectul consumator: `.ai-code-worker/`
- Scop: orchestrarea sigură și reluabilă a implementării de cod dintr-un plan acceptat

## 0. Amendamentele v1.2

Versiunea 1.2 păstrează arhitectura de bază și toate corecțiile v1.1, dar mută controalele necesare autonomiei înaintea primului pilot real. Textul normativ complet este în [Amendament v1.2 — siguranță, autorizare și recovery înainte de pilot](amendments/v1.2-safety-execution-and-recovery.md).

1. starea operațională (`runs`, worktree-uri, cache, loguri și SQLite) este mutată implicit în afara repository-ului consumator;
2. `doctor` detectează directoarele sincronizate, iar writerii paraleli sunt blocați când Git common directory se află sub OneDrive sau un alt sync root cunoscut;
3. interoperabilitatea dintre worker, `ai-code-control` și Git hooks este normată prin [AICW-ADR-001](adr/0001-scope-hook-interoperability.md);
4. bugetele de usage și cost intră în Faza 1, cu tokenii uncached, cache-read și cache-write raportați separat;
5. eșecurile deterministe, flaky, de infrastructură, de policy și de motor au tratamente diferite;
6. review-ul include obligatoriu matricea criteriu → test → comandă → dovadă, iar task-urile cu risc ridicat pot cere un test engineer independent;
7. adaptoarele refuză implicit versiunile de motor netestate și permit numai intervale validate plus capability smoke tests;
8. worktree-ul rămâne mecanism Git, iar toate procesele controlate de repository rulează printr-un `ExecutionEnvironment`; profilul autonom implicit este `isolated`, conform [AICW-ADR-002](adr/0002-execution-environments.md);
9. instrucțiunile urmează un trust model monoton, iar scrierea cere un `RunAuthorization` imutabil legat de manifest, conform [AICW-ADR-003](adr/0003-instruction-trust-and-run-authorization.md);
10. fiecare task dependent primește un snapshot determinist al closure-ului dependențelor, conform [AICW-ADR-004](adr/0004-dependency-snapshots-and-graph-revisions.md);
11. adaptoarele folosesc un protocol streaming cu session binding, usage, heartbeat și anulare, conform [AICW-ADR-005](adr/0005-streaming-engine-adapter.md);
12. lease, reconciliere și idempotency minimă intră în Faza 1 înaintea pilotului, conform [AICW-ADR-006](adr/0006-minimum-recovery-before-pilot.md);
13. distribuția prin submodule este canal de bootstrap și pilot, nu o invariantă a release-ului stabil;
14. pilotul are un gate tehnic de trei task-uri și un gate de valoare de minimum opt, cu țintă zece task-uri reprezentative;
15. cele 10–15 zile sunt un prototype timebox, nu estimarea pentru Definition of Done.

## 1. Decizia pe scurt

`ai-code-worker` trebuie construit ca un instrument independent, versionat într-un repository Git propriu. În bootstrap și pilot poate fi adăugat în proiectele consumatoare ca submodule; înainte de release stabil canalul de distribuție se fixează printr-o decizie separată. El nu este o extensie a `ai-code-control` și nu îi va referenția proiectele, bazele de date sau tipurile interne.

Topologia recomandată este:

```text
repository-produs/
├── ai-code-worker/             # submodule Git: motorul generic, independent
├── .ai-code-worker/            # configurație versionată; starea operațională este externă
├── ai-code-control/            # submodule separat, opțional
├── .ai-code-control/           # memoria/contextul proiectului, opțional
├── AGENTS.md
├── CLAUDE.md
└── Plan/
```

Separarea dintre `ai-code-worker/` și `.ai-code-worker/` este intenționată:

- `ai-code-worker/` conține CLI-ul, schemele, adaptoarele Codex/Claude, politicile implicite și testele generice;
- `.ai-code-worker/` conține numai configurația versionată a proiectului, quality gates și politicile locale;
- starea operațională și artefactele brute ale rulărilor sunt păstrate într-un state root local, în afara repository-ului;
- actualizarea submodulului nu suprascrie configurația proiectului;
- același worker poate fi instalat în consumer project sau în orice alt repository;
- în canalul submodule, repository-ul produsului fixează explicit versiunea worker-ului prin commitul submodulului;
- într-un canal extern, repository-ul păstrează numai `.ai-code-worker/` și versiunea CLI cerută.

Nucleul trebuie să fie un CLI TypeScript care deține starea, Git worktree-urile, procesele agenților, validarea JSON Schema, integrarea și repair loop-ul. Skills, custom agents, hooks și comenzile native ale fiecărui motor sunt adaptoare de experiență, nu sursa de adevăr a workflow-ului.

## 2. Responsabilități și limite

### 2.1 Ce face ai-code-worker

- primește un plan Markdown acceptat și o referință Git de bază;
- rulează preflight-ul repository-ului;
- compilează planul într-un manifest executabil și validat;
- construiește un DAG de task-uri cu ownership de fișiere;
- creează branch-uri și worktree-uri separate și pornește procesele prin mediul de execuție autorizat;
- pornește Codex sau Claude Code cu permisiuni și output schema explicite;
- verifică modificările, comenzile, criteriile și artefactele fiecărui task;
- creează commit-uri atomice după verificare;
- integrează commit-urile în ordinea dependențelor;
- rulează quality gates globale;
- solicită un review independent, read-only;
- execută reparații strict delimitate, cu buget finit;
- produce `DONE` numai cu dovezi complete sau `BLOCKED` cu cauze verificabile;
- poate relua o rulare întreruptă fără a repeta task-urile deja validate;
- construiește pentru fiecare task un snapshot verificabil al dependențelor sale.

### 2.2 Ce nu face

- nu păstrează memoria de produs și nu indexează codul; acestea sunt responsabilități `ai-code-control` atunci când este instalat;
- nu decide cerințe de business neclare;
- nu tratează răspunsul unui model drept dovadă de succes;
- nu face deploy, merge în branch protejat, force-push sau migrații destructive;
- nu citește ori persistă secrete în afara unei liste explicite de variabile permise;
- nu modifică testele, contractele sau quality gates doar pentru a obține verde;
- nu pornește automat doar pentru că un fișier din repository îi menționează numele;
- nu depinde de o singură versiune sau capabilitate experimentală Codex/Claude.

## 3. Evaluarea recomandărilor ForgeFlow

Recomandările primite au nucleul corect, dar câteva detalii trebuie ajustate pentru un instrument repetabil.

| Recomandare | Decizie | Motiv |
|---|---|---|
| manifest executabil înainte de implementare | păstrată | elimină improvizația și permite validare mecanică |
| DAG, `allowedPaths`, worktree-uri și review independent | păstrate | sunt controalele centrale ale sistemului |
| contracte înainte de frontend/backend | păstrată condiționat | este obligatorie numai când task-ul schimbă o interfață comună |
| fiecare agent face commit | modificată | agentul scrie; coordinatorul verifică diff-ul și creează commit-ul |
| plan compiler read-only | păstrată | returnează JSON; coordinatorul scrie manifestul validat |
| coordinator implementat doar ca prompt/agent nativ | respinsă pentru nucleu | promptul nu oferă stare, locking, reluare și integrare deterministă |
| custom agents Codex și Claude | păstrată ca adaptor | utile pentru roluri, dar CLI-ul rămâne autoritatea workflow-ului |
| Claude agent teams | amânată/opțională | funcționalitate experimentală și mai costisitoare; nu este necesară pentru MVP |
| „dynamic workflows” ca mecanism Claude distinct | reformulată | se va folosi Agent SDK/CLI programatic; planul nu depinde de o denumire de produs neclară |
| `/goal` pentru finalizare | opțională | evaluatorul citește transcriptul, dar nu rulează singur verificările |
| maximum trei repair cycles | păstrată ca valoare implicită | limita rămâne configurabilă și se oprește mai devreme la eșec repetat identic |

Capabilitățile actuale care justifică adaptoarele sunt documentate oficial:

- Codex acceptă custom agents în `.codex/agents/`, subagenți, mod read-only, `codex exec`, output conform JSON Schema, reluarea sesiunilor și SDK TypeScript; vezi [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) și [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).
- Claude Code acceptă custom subagents în `.claude/agents/`, `isolation: worktree`, execuție headless, flux `stream-json`, output conform JSON Schema și evenimente pentru subagenți imbricați; coordinatorul principal rămâne extern pentru ca starea, autorizarea și recovery-ul să nu depindă de comportamentul intern al motorului; vezi [Subagents](https://code.claude.com/docs/en/sub-agents), [Worktrees](https://code.claude.com/docs/en/worktrees) și [Headless mode](https://code.claude.com/docs/en/headless).
- Claude agent teams sunt experimentale și dezactivate implicit; vezi [Agent teams](https://code.claude.com/docs/en/agent-teams). `/goal` are evaluator separat, dar acesta nu execută uneltele; vezi [Goals](https://code.claude.com/docs/en/goal).

Aceste capabilități trebuie verificate de `ai-code-worker doctor`. O schimbare în CLI-urile furnizorilor trebuie să afecteze numai adaptorul respectiv.

## 4. Arhitectura țintă

```text
cerere explicită + plan acceptat
               │
               ▼
          Run Intent
      compile read-only only
               │
               ▼
       ai-code-worker CLI
               │
      ┌────────┼──────────┐
      ▼        ▼          ▼
   Policy   Run state   Context provider
   engine   event log   none / optional
      │        │
      └────┬───┘
           ▼
      Plan compiler
     read-only process
           │
           ▼
 manifest validat + DAG înghețat
           │
           ▼
    Run Authorization
  bound to manifest + base
           │
           ▼
 Dependency Snapshot Builder
           │
     ┌─────┴──────────────┐
     ▼                    ▼
task worktree A     task worktree B
ExecutionEnvironment isolated/trusted-local
Codex/Claude events + result schema
     │                    │
     └──── verified input ┘
              │
              ▼
 scope + isolated gates + commit controlat
              │
              ▼
       integration worktree
              │
              ▼
 isolated global gates + independent review
       │ PASS             │ FAIL
       ▼                  ▼
      DONE        bounded repair / BLOCKED
```

### 4.1 Modulele motorului

| Modul | Responsabilitate |
|---|---|
| `cli` | comenzi, exit codes, output uman/JSON |
| `core` | state machine, DAG scheduler, invarianți |
| `manifest` | JSON Schema, compilare, normalizare, hash/freeze |
| `authorization` | run intent, grant binding, capabilities și approval modes |
| `policy` | permisiuni, scope, risc, bugete, comenzi interzise |
| `git` | preflight, branch, worktree, diff, commit, cherry-pick |
| `snapshots` | closure de dependențe, input commit/tree și invalidare |
| `execution` | backend-uri isolated/trusted-local, mounts, rețea și limite |
| `runner` | procese, streaming, timeout, anulare, captură și redactare output |
| `engines/codex` | traducerea contractului comun către Codex CLI/SDK |
| `engines/claude` | traducerea contractului comun către Claude Code CLI/SDK |
| `context` | provider implicit și adaptor opțional `ai-code-control` |
| `validation` | task gates, global gates, dovezi și digest-uri |
| `review` | findings, severitate, deduplicare, repair task-uri |
| `persistence` | event log append-only, snapshots și index SQLite rebuildable |
| `redaction` | protecția secretelor și limitarea logurilor |
| `integration` | ordonare topologică, commit-uri și conflict policy |

## 5. Instalarea într-un proiect

### 5.1 Submodule Git

```powershell
npm ci --prefix modules/ai-code-worker
npm run build --prefix modules/ai-code-worker
npm ci --prefix ai-code-worker
npm run build --prefix ai-code-worker
node ai-code-worker/dist/cli.js init --engines codex,claude
```

`init` trebuie să fie idempotent: nu suprascrie fișiere existente și afișează un diff atunci când trebuie actualizat un bloc administrat. Submodulul este canalul de bootstrap/pilot; un release stabil poate furniza același CLI prin pachet sau executable extern fără a schimba contractele `.ai-code-worker/`.

Nu recomand un repository Git imbricat direct în `.ai-code-worker/`. Git tooling, worktree-urile și clonele recursive sunt mai predictibile cu un submodule declarat în `.gitmodules` și cu starea proiectului într-un director separat.

### 5.2 Blocul minim din AGENTS.md

Installerul propune, dar nu adaugă fără confirmare, un bloc delimitat și versionat:

```markdown
## ai-code-worker

Folosește ai-code-worker numai când utilizatorul îl invocă explicit sau cere ca un
plan să fie executat prin el. Nu începe implementarea înainte ca manifestul rulării
să fie valid și înghețat și authorization binding-ul să fie valid. Configurația
worker-ului este în `.ai-code-worker/`; starea operațională este în state root-ul
extern. Respectă rezultatul DONE/BLOCKED al worker-ului.
```

`CLAUDE.md` trebuie să trimită la `AGENTS.md`, nu să dubleze regulile. Instrucțiunile permanente rămân concise; procedura detaliată stă în skill/adaptor.

### 5.3 Invocare explicită

Interfața autoritativă este CLI-ul:

```powershell
./scripts/ai-code-worker.ps1 run Plan/PLAN-X.md --engine codex
./scripts/ai-code-worker.ps1 run Plan/PLAN-X.md --engine claude
./scripts/ai-code-worker.ps1 resume <run-id>
```

Adaptoarele conversaționale oferă aceeași intenție:

```text
Codex:       $ai-code-worker implementează Plan/PLAN-X.md
Claude Code: /ai-code-worker Plan/PLAN-X.md
Natural:     Implementează Plan/PLAN-X.md folosind ai-code-worker.
```

Worker-ul nu se activează implicit din frontmatter-ul unui plan. Un fișier din repository nu poate acorda singur autorizația de a modifica repository-ul.

## 6. Configurația proiectului consumator

Structura versionată recomandată:

```text
.ai-code-worker/
├── config.json
├── policy.json
├── quality-gates.json
├── adapters.json
├── README.md
├── install.json
└── pilot-baseline.json         # apare numai când se aprobă pilotul
```

Exemplu minimal `config.json`:

```json
{
  "schemaVersion": "1.0",
  "defaultEngine": "codex",
  "contextProvider": "none",
  "baseBranch": "main",
  "integrationBranchPrefix": "aiw/integration/",
  "taskBranchPrefix": "aiw/task/",
  "maximumParallelWriters": 2,
  "maximumRepairCycles": 3,
  "maximumRunMinutes": 180,
  "executionEnvironment": {
    "defaultProfile": "isolated",
    "allowTrustedLocal": false
  },
  "stateRoot": null,
  "syncRootPolicy": {
    "sequentialWriter": "warn",
    "parallelWriters": "block"
  }
}
```

`stateRoot: null` înseamnă un director local separat per repository hash:

- Windows: `%LOCALAPPDATA%\ai-code-worker\repos\<repo-hash>`;
- Linux: `$XDG_STATE_HOME/ai-code-worker/repos/<repo-hash>` sau `~/.local/state/ai-code-worker/repos/<repo-hash>`;
- macOS: `~/Library/Application Support/ai-code-worker/repos/<repo-hash>`.

Sub acesta se află `runs/`, `worktrees/`, `cache/`, `logs/` și indexul SQLite rebuildable. Numai un raport final redactat poate fi exportat explicit în repository.

Preflight-ul rezolvă atât root-ul worktree-ului, cât și `git rev-parse --git-common-dir`. [Git documentează](https://git-scm.com/docs/git-worktree.html) că worktree-urile legate partajează Git common directory. Mutarea worktree-ului în afara OneDrive nu este suficientă când acest director comun rămâne sincronizat, iar [Microsoft documentează](https://support.microsoft.com/en-us/office/restrictions-and-limitations-in-onedrive-and-sharepoint-64883a5d-228e-48f5-b3d2-eb39e07630fa) conflicte și restricții de sincronizare pentru fișiere aflate în uz. În v1, modul cu writeri paraleli se blochează în această situație; modul secvențial avertizează. Pentru pilot și pentru rulări paralele se recomandă o clonă locală în afara oricărui sync root.

`policy.json` definește permisiuni, nu secrete. `quality-gates.json` definește executabile, argumente, director de lucru, timeout și variabile de mediu permise; comenzile nu sunt stocate ca șiruri shell arbitrare atunci când pot fi reprezentate ca `executable + args`. Toate aceste comenzi rulează prin `ExecutionEnvironment`, inclusiv hook-urile și build scripts.

## 7. Contractul planului uman

Planul Markdown rămâne documentul pentru om și trebuie să precizeze cel puțin:

- identificator și status (`proposed`, `accepted`, `superseded`);
- obiectiv măsurabil;
- non-obiective;
- surse canonice și decizii aplicabile;
- criterii de acceptanță numerotate;
- constrângeri de securitate și compatibilitate;
- verificări obligatorii cunoscute;
- riscuri și dependențe;
- decizii încă deschise.

Worker-ul execută numai planuri `accepted`, cu excepția modului `compile --allow-proposed`, care este strict read-only. Dacă o regulă materială este propusă ori două surse canonice se contrazic, compilarea se termină `BLOCKED`; plan compiler-ul nu alege singur o interpretare.

## 8. Manifestul executabil

Plan compiler-ul rulează read-only și returnează un obiect conform `manifest.schema.json`. Coordinatorul validează, normalizează, scrie și îngheață manifestul. După înghețare, orice schimbare materială marchează rularea `SUPERSEDED` și produce o rulare nouă, cu alt `runId`, `graphVersion` incrementat și authorization binding nou; manifestul inițial nu este suprascris în tăcere.

Exemplu redus:

```json
{
  "schemaVersion": "1.0",
  "runId": "20260731-auth-refresh-a1b2",
  "graphVersion": 1,
  "plan": {
    "path": "Plan/AUTH-REFRESH.md",
    "sha256": "...",
    "status": "accepted"
  },
  "base": {
    "ref": "main",
    "commit": "<full-sha>"
  },
  "goal": "Implement refresh-token rotation end-to-end",
  "tasks": [
    {
      "id": "CONTRACT-01",
      "kind": "contract",
      "role": "contract-engineer",
      "dependsOn": [],
      "requiredInputs": ["contracts/openapi/auth.yaml"],
      "allowedPaths": ["contracts/openapi/auth.yaml"],
      "forbiddenPaths": [".github/**"],
      "expectedArtifacts": ["contracts/openapi/auth.yaml"],
      "acceptanceCriteria": ["AC-01", "AC-02"],
      "verify": ["contract-generate", "contract-drift"],
      "concurrencyKeys": ["contracts/auth"],
      "risk": "medium"
    }
  ],
  "globalGates": ["backend-build", "backend-tests", "frontend-typecheck"],
  "budgets": {
    "maximumParallelWriters": 2,
    "maximumRepairCycles": 3,
    "maximumTaskMinutes": 45,
    "maximumRunMinutes": 180,
    "maximumAgentInvocations": 12,
    "maximumRunInputUncachedTokens": 1000000,
    "maximumRunCacheReadTokens": 5000000,
    "maximumRunCacheWriteTokens": 1000000,
    "maximumRunOutputTokens": 100000,
    "maximumRunCostUsd": null,
    "onUnknownUsage": "block-if-cost-required"
  }
}
```

Bugetele de tokeni sunt independente. Un cache read nu consumă bugetul de input uncached, iar valorile cache-read/cache-write nu se combină într-un singur `maximumRunInputTokens`. `maximumRunCostUsd` este aplicabil numai când adaptorul oferă cost raportat suficient de fiabil; o estimare locală nu este tratată ca limită financiară exactă.

### 8.1 Câmpuri obligatorii per task

- `id`, `kind`, `role`;
- `dependsOn`;
- `requiredInputs` și `expectedArtifacts`;
- `allowedPaths` și `forbiddenPaths`;
- criterii de acceptanță referite prin ID;
- verificări referite prin ID din configurația proiectului;
- condiții de blocare;
- risc și buget;
- `concurrencyKeys`;
- strategie de rollback local/retry;
- motivul pentru care task-ul poate sau nu poate rula în paralel.

Commiturile dependențelor nu sunt cunoscute la freeze și nu sunt inventate în manifest. Înainte de `READY`, worker-ul creează un `TaskInputSnapshot` runtime cu `rootBaseCommit`, commiturile dependențelor directe/tranzitive, `inputCommit`, `inputTree` și digestul metadatelor. Contractul este definit de [AICW-ADR-004](adr/0004-dependency-snapshots-and-graph-revisions.md).

### 8.2 Validări înainte de execuție

- schema JSON este validă și versiunea este suportată;
- planul și commitul de bază există și hash-urile corespund;
- DAG-ul este aciclic și toate dependențele există;
- fiecare criteriu al planului este acoperit de cel puțin un task și o dovadă;
- task-urile paralele nu au globs ori `concurrencyKeys` suprapuse;
- fiecare verificare referită este definită;
- task-urile de scriere au cel puțin un `allowedPath` și un worktree;
- task-urile read-only nu cer unelte de scriere;
- contractele preced consumatorii când există interfețe comune;
- migrațiile existente nu sunt editate și comenzile interzise nu sunt cerute;
- scope-ul total nu depășește fișierele și obiectivele planului acceptat.

## 9. Contractele rezultatelor

### 9.1 Task result

Agentul returnează date structurate; afirmațiile sunt apoi reverificate de worker.

```json
{
  "schemaVersion": "1.0",
  "taskId": "BE-01",
  "status": "candidate",
  "summary": "Implemented refresh-token rotation.",
  "changedFilesClaimed": ["backend/Auth/RefreshTokenService.cs"],
  "commandsClaimed": [
    { "gateId": "backend-tests", "exitCode": 0 }
  ],
  "acceptanceEvidenceClaimed": [
    { "criterionId": "AC-03", "evidence": "RefreshTokenTests.RotateOnce" }
  ],
  "assumptions": [],
  "blockers": []
}
```

Statusul agentului este `candidate`, nu `passed`. Worker-ul calculează independent:

- lista reală de fișiere din `git diff`;
- încălcările de scope;
- commitul de bază și faptul că agentul nu a mutat `HEAD`;
- comenzile realmente rulate de worker și exit codes;
- artefactele existente;
- dovezile și digest-urile logurilor.

Abia apoi worker-ul produce `task-verification.json` cu `PASSED`, creează commitul și salvează hash-ul. Agentului i se cere explicit să nu ruleze `git commit`, `git push`, `git reset`, `git clean` sau `git worktree`.

### 9.2 Usage evidence

Worker-ul normalizează usage-ul fără să piardă valorile brute furnizate de motor:

```json
{
  "engine": "codex",
  "usageSource": "engine-reported",
  "input": {
    "uncachedTokens": 12500,
    "cacheReadTokens": 87500,
    "cacheWriteTokens": null,
    "totalReportedTokens": 100000
  },
  "output": {
    "standardTokens": 4200,
    "reasoningTokens": 1800,
    "totalReportedTokens": 6000
  },
  "cost": {
    "reportedUsd": null,
    "estimatedUsd": null
  },
  "complete": true
}
```

Invariante:

- `uncachedTokens`, `cacheReadTokens` și `cacheWriteTokens` sunt câmpuri distincte și au bugete distincte;
- `totalReportedTokens` păstrează totalul motorului chiar dacă semantica sa se suprapune cu subcâmpurile;
- o valoare indisponibilă este `null`, niciodată `0`;
- costul raportat și costul estimat nu se însumează și nu sunt interschimbabile;
- worker-ul păstrează și payload-ul brut redactat sau digest-ul său pentru auditul adaptorului;
- bugetele sunt verificate înaintea fiecărei noi invocări și după fiecare eveniment de usage; un motor care raportează numai la final nu poate garanta oprirea în interiorul invocării active;
- dacă politica cere o limită monetară iar adaptorul nu poate furniza cost fiabil, rularea se oprește înaintea următoarei invocări cu `USAGE_UNKNOWN`.

[Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode) expune în evenimentul final tokenii de input, cached input, output și reasoning. [Claude Code headless](https://code.claude.com/docs/en/headless) poate raporta costul invocării, iar [CLI-ul Claude](https://code.claude.com/docs/en/cli-usage) acceptă o limită monetară în print mode. Adaptorul traduce aceste forme în contractul comun, fără a inventa echivalențe între abonamente, credite și facturare API.

### 9.3 Review result

```json
{
  "verdict": "fail",
  "criterionCoverage": [
    {
      "criterionId": "AC-03",
      "verdict": "contradicted",
      "tests": ["RefreshTokenTests.RotateOnce"],
      "commands": ["backend-tests"],
      "evidence": "Testul trece secvențial, dar nu acoperă două refresh-uri concurente."
    }
  ],
  "findings": [
    {
      "id": "REV-001",
      "severity": "blocking",
      "category": "correctness",
      "criterionIds": ["AC-03"],
      "files": ["backend/Auth/RefreshTokenService.cs"],
      "evidence": "Concurrent refresh accepts the same token twice.",
      "recommendedScope": ["backend/Auth/**", "backend.tests/Auth/**"]
    }
  ]
}
```

Fiecare criteriu primește exact un verdict `supported`, `weak`, `missing` sau `contradicted`. Un finding fără fișier, comportament reproductibil sau criteriu afectat nu poate genera automat un repair task blocant. Reviewerul nu modifică fișiere și nu primește contextul conversațional al implementatorului.

### 9.4 Rolul independent de test

Pentru `risk: high`, politica poate cere două controale suplimentare:

1. un test designer read-only produce înaintea implementării o matrice de scenarii și dovezi necesare;
2. după commitul implementării, un test engineer cu context separat inspectează criteriile și poate adăuga teste independente într-un task dependent.

Dacă test engineer-ul scrie, el deține exclusiv căile de test declarate; writer-ul de producție nu le modifică în același val paralel. Task-ul de test rulează după implementare sau după contract freeze, conform DAG-ului, iar review-ul final rămâne read-only.

## 10. State machine și persistență

### 10.1 Stările rulării

```text
CREATED
  → PREFLIGHTED
  → COMPILED
  → FROZEN
  → AUTHORIZED
  → EXECUTING
  → INTEGRATING
  → VERIFYING
  → REVIEWING
  → DONE
       sau
    REPAIRING ──┐
       ▲        │
       └────────┘
       sau
    RECOVERING
       sau
    BLOCKED / CANCELLED / SUPERSEDED
```

### 10.2 Stările task-ului

```text
PENDING → READY → RUNNING → VERIFYING → PASSED → INTEGRATED
   │       │             │           │
   └───────┴─────────────┴───────────┴→ STALE / FAILED / BLOCKED
                                      → SKIPPED / CANCELLED / SUPERSEDED
```

Tranzițiile sunt validate în cod și scrise într-un `events.jsonl` append-only. `state.json` este un snapshot regenerabil. Un SQLite local indexează evenimentele, lease-urile și task-urile pentru scheduling, dar trebuie să poată fi reconstruit din artefactele rulării.

Structura unei rulări:

```text
$STATE_ROOT/runs/<run-id>/
├── run.json
├── run-intent.json
├── authorization.json
├── manifest.candidate.json
├── manifest.json
├── manifest.sha256
├── events.jsonl
├── state.json
├── tasks/<task-id>/
│   ├── request.json
│   ├── task-input.json
│   ├── engine-events.jsonl
│   ├── agent-result.json
│   ├── verification.json
│   └── evidence.json
├── integration.json
├── gates.json
├── review.json
├── repairs/
├── final-report.md
└── BLOCKED.md
```

Nu se persistă transcriptul brut al modelului. Se păstrează numai inputul structurat minim, rezultatul structurat, evenimente redactate, exit codes, durate, hash-uri și fragmente de eroare limitate ca mărime.

### 10.3 Reluare și idempotență

`resume` intră mai întâi în `RECOVERING`, reface starea din event log, verifică authorization binding-ul, toate worktree-urile, procesele și commit-urile și continuă numai de la un checkpoint demonstrabil. Un task `PASSED` nu este reluat dacă:

- commitul verificat încă există;
- hash-ul manifestului, authorization binding-ul și graph version nu s-au schimbat;
- artefactele și dovezile au digest valid;
- task-ul nu a fost invalidat de o revizie de manifest sau de un repair dependent.

Se folosește un lease per rulare, cu PID, host fingerprint, process start time, coordinator instance ID și heartbeat. Al doilea coordinator refuză rularea cât timp lease-ul este valid. După crash, lease-ul poate fi recuperat numai prin `resume`, niciodată prin ștergere automată a worktree-urilor cu modificări. Efectele worker-ului folosesc idempotency keys, iar orice stare ambiguă produce `BLOCKED/RECOVERY_AMBIGUOUS`, conform [AICW-ADR-006](adr/0006-minimum-recovery-before-pilot.md).

### 10.4 Replanning și invalidare

Manifestul înghețat nu revine la `COMPILED`. O schimbare de scope, criterii, graf sau authorization marchează rularea `SUPERSEDED` și creează o rulare nouă cu alt `runId`, `graphVersion` incrementat și `supersedesRunId`. Un repair în același scope poate crea un attempt nou; dacă schimbă commitul unei dependențe, numai descendenții tranzitivi devin `STALE` și primesc snapshot nou.

## 11. Fluxul complet

### 11.1 Preflight

Worker-ul verifică:

- repository Git și remote/base ref;
- submodule inițializate;
- tree de integrare curat;
- lipsa unei alte rulări active incompatibile;
- versiunile Node, Git, Codex/Claude și adaptoarelor;
- calea, versiunea și hash-ul binarului fiecărui motor față de profilul de compatibilitate testat;
- autentificarea motorului fără a afișa tokenuri;
- disponibilitatea comenzilor din quality gates;
- spațiu pe disc, containere și servicii locale declarate;
- existența planului și statusul `accepted`;
- politica de rețea și variabilele de mediu permise.
- `RunIntent`, capabilitățile cerute și limitele dure de consum;
- backendul `ExecutionEnvironment`, capability report-ul și digestul profilului;
- `stateRoot`, permisiunile sale și faptul că nu se află într-un sync root cunoscut;
- worktree root și Git common directory, rezolvate separat;
- hook-urile Git active și posibilitatea executării lor din fiecare worktree;

Un checkout murdar blochează rularea de scriere. Worker-ul nu execută automat `stash`, `reset`, `clean` sau mutarea fișierelor utilizatorului. Modul read-only de compilare poate continua cu avertisment, dar manifestul înregistrează commitul curat, nu modificările necomise.

Pe Windows, `doctor` compară căile rezolvate cu rădăcinile OneDrive cunoscute și cu alte sync roots configurate. Dacă Git common directory este sincronizat, `maximumParallelWriters > 1` produce `BLOCKED`; mutarea exclusivă a worktree-urilor nu este considerată remediere completă.

### 11.2 Compile și freeze

1. Se citește planul complet și contextul canonic.
2. Providerul de context adaugă numai informația necesară.
3. Plan compiler-ul read-only returnează manifestul candidat.
4. Worker-ul validează schema, DAG-ul, scope-ul, coverage-ul criteriilor și politica.
5. Ambiguitățile materiale produc `BLOCKED.md`.
6. Manifestul valid este normalizat, hash-uit și înghețat.
7. Capabilitățile manifestului sunt comparate cu `RunIntent` și policy-ul extern.
8. Worker-ul scrie `authorization.json` legat de plan, manifest, base commit, graph version și execution profile.

Auto-freeze este permis numai dacă manifestul nu extinde scope-ul planului și riscul este sub pragul configurat. Altfel rularea cere o autorizație nouă sau se oprește `BLOCKED`, în funcție de approval mode. `approvalMode: "never"` nu suspendă și nu aprobă implicit: orice capabilitate lipsă produce `BLOCKED`.

### 11.3 Execuția task-urilor

Schedulerul selectează task-urile `READY`. Paralelismul este permis numai când:

- dependențele sunt satisfăcute;
- `allowedPaths` și `concurrencyKeys` nu se suprapun;
- bugetul de writeri nu este depășit;
- task-urile nu folosesc aceeași bază de date/serviciu exclusiv;
- ordinea migrațiilor și contractelor este respectată.
- Git common directory nu se află într-un sync root blocat de policy.
- `TaskInputSnapshot` a fost construit din closure-ul dependențelor și digesturile corespund.

Fiecare task primește un worktree pornit din `inputCommit`, un branch, `task-input.json`, o cerere JSON, instrucțiuni de rol, criteriile proprii, comenzile de verificare și permisiunile minime. Agentul nu primește întregul transcript al coordinatorului. Conținutul repository-ului și outputul extern sunt date neîncrezătoare; pot restrânge prin policy aplicată mecanic, dar nu pot extinde grantul.

### 11.4 Verificarea task-ului și commit

După oprirea agentului, worker-ul:

1. verifică dacă `HEAD` a rămas la baza task-ului;
2. obține lista reală de fișiere modificate și neversionate;
3. blochează orice cale din afara scope-ului;
4. verifică absența fișierelor secrete și binare nepermise;
5. rulează task gates prin `ExecutionEnvironment`, într-un mediu curat și cu rețeaua/variabilele limitate;
6. leagă fiecare criteriu de o dovadă;
7. dacă providerul de scope o cere, materializează manifestul compatibil în worktree și rulează verificarea directă;
8. adaugă numai căile de business permise în staging; manifestul temporar nu este staged;
9. creează commitul fără `--no-verify`, lăsând toate hook-urile proiectului să ruleze prin același profil de execuție autorizat;
10. adaugă trailerele `AIW-Run`, `AIW-Task` și `AIW-Manifest-SHA` numai ca audit metadata;
11. restaurează exact conținutul anterior al manifestului temporar și blochează rularea dacă restaurarea nu poate fi demonstrată;
12. marchează task-ul `PASSED` numai după ce hash-ul commitului este salvat.

Detaliile normative sunt în [AICW-ADR-001](adr/0001-scope-hook-interoperability.md). Trailerul nu autorizează hook-ul `pre-commit`, deoarece acel hook rulează înaintea pregătirii mesajului commitului.

### 11.5 Integrarea

Un worktree separat pornește exact din commitul de bază și primește commit-urile în ordine topologică. Integratorul automat nu scrie cod de business. La conflict:

- integrarea se oprește;
- se salvează fișierele și commit-urile aflate în conflict;
- se poate crea un task de integrare îngust, cu scope exclusiv pe acele fișiere;
- după rezolvare se rerulează toate gate-urile afectate și apoi gate-urile globale.

Branch-ul utilizatorului nu este mutat până la `DONE` și nici atunci fără comanda explicită `apply`/`export`. Implicit, rezultatul rămâne pe branch-ul de integrare al worker-ului.

### 11.6 Quality gates, review și repair

Ordinea este:

1. global build/generate/drift checks;
2. unit tests;
3. integration/contract tests;
4. lint/typecheck/static analysis;
5. migration validation;
6. verificări de securitate configurate;
7. review independent read-only;
8. repair tasks pentru findings blocante;
9. rerularea gate-urilor locale și globale după fiecare repair batch.

Fiecare rezultat de gate este clasificat înaintea repair loop-ului:

| Clasă | Tratament |
|---|---|
| `DETERMINISTIC_FAILURE` | poate genera un repair task delimitat |
| `FLAKY` | nu consumă repair cycle; blochează implicit `DONE` |
| `INFRASTRUCTURE_FAILURE` | retry controlat sau `BLOCKED`, fără schimbare de cod |
| `POLICY_FAILURE` | `BLOCKED`; necesită autoritate nouă sau corectarea manifestului |
| `ENGINE_FAILURE` | retry/adaptor failure; nu este atribuit implementării |

Un gate poate avea `retryPolicy: "once-on-same-commit"`. Retry-ul rulează pe același commit și într-un mediu echivalent. Dacă prima execuție eșuează și retry-ul trece, rezultatul este `FLAKY`, nu `PASSED`.

Quarantine este permisă numai prin configurație versionată cu owner, issue/TODO, motiv și dată de expirare. Un gate quarantined nu devine invizibil și este raportat în `final-report.md`; politica proiectului decide explicit dacă permite `DONE`.

Repair loop-ul implicit are maximum trei cicluri și primește automat numai eșecuri deterministe. Se oprește mai devreme dacă aceeași semnătură reapare fără progres, dacă reparația cere extinderea planului sau dacă bugetul de timp, usage ori cost este consumat.

## 12. Adaptoarele de motor

Interfața internă comună trebuie să ofere:

```ts
interface EngineAdapter {
  doctor(): Promise<CapabilityReport>;
  start(request: AgentRequest): Promise<ExecutionHandle>;
  resume(request: ResumeRequest): Promise<ExecutionHandle>;
  cancel(handle: ExecutionHandle, reason: string): Promise<CancelResult>;
}

interface ExecutionHandle {
  executionId: string;
  sessionId?: string;
  events: AsyncIterable<EngineEvent>;
  completed: Promise<AgentExecutionResult>;
}
```

`AgentRequest` conține `cwd`, rol, prompt, schema rezultatului, execution profile, policy, timeout, env allowlist și identificatori de corelare. Adapterul nu decide DAG-ul, scope-ul sau starea. Evenimentele au sequence monoton, sunt redactate și limitate înainte de persistență, iar `sessionId` se salvează imediat ce motorul îl raportează. Detaliile normative sunt în [AICW-ADR-005](adr/0005-streaming-engine-adapter.md).

### 12.1 Codex

MVP-ul folosește `codex exec` deoarece oferă o limită clară de proces și output structurat:

```text
codex exec --json --sandbox workspace-write --output-schema <schema> -o <result> <prompt>
codex exec resume <session-id> <prompt>
```

Plan compiler-ul și reviewerul folosesc `read-only`. Writerii folosesc `workspace-write` cu worktree-ul drept director de lucru în interiorul profilului `ExecutionEnvironment`; sandboxul motorului este defense-in-depth și nu substituie izolarea gate-urilor ori hook-urilor. `danger-full-access` nu este permis implicit.

SDK-ul TypeScript poate înlocui ulterior procesul CLI în interiorul adaptorului pentru control mai fin al thread-urilor. Manifestul și event log-ul nu trebuie să conțină tipuri specifice SDK-ului.

Fișierele `.codex/agents/*.toml` și skill-ul `.agents/skills/ai-code-worker/SKILL.md` sunt generate ca shims versionate. Ele invocă worker-ul sau descriu rolurile; nu țin starea rulării.

### 12.2 Claude Code

MVP-ul folosește modul headless:

```text
claude --bare -p <prompt> --output-format stream-json --verbose --json-schema <schema>
```

Worker-ul creează worktree-ul înainte să pornească procesul, astfel încât aceeași strategie Git funcționează pentru ambele motoare. Modul automatizat folosește `--bare` și injectează explicit contextul aprobat; shims și `CLAUDE.md` rămân numai pentru UX interactiv. `isolation: worktree` rămâne disponibil pentru folosirea interactivă a agentului, dar nu este autoritatea worktree-urilor sau a sandboxului de proces dintr-o rulare orchestrată.

Fișierele `.claude/agents/*.md` și `.claude/skills/ai-code-worker/SKILL.md` sunt shims. Coordinatorul Claude trebuie activat ca sesiune principală sau prin CLI-ul extern; nu trebuie delegat ca subagent și apoi instruit să creeze alți subagenți.

`/goal` poate fi folosit în modul interactiv ca ajutor de persistență, însă condiția sa trebuie să ceară afișarea exit code-urilor. DONE rămâne calculat din artefactele worker-ului, nu din verdictul evaluatorului `/goal`.

### 12.3 Matrice de capabilități

`doctor --json` produce și salvează:

- calea și hash-ul binarului motorului;
- versiunea motorului;
- intervalul de versiuni testat de adaptor;
- suport pentru JSON Schema;
- suport pentru resume;
- sandbox modes disponibile;
- custom agents/skills disponibile;
- limită de paralelism configurată;
- hooks/worktree disponibile;
- autentificare validă;
- deviații față de versiunea testată a adaptorului.
- câmpurile de usage/cost pe care motorul le poate raporta și momentul raportării.
- tipurile de evenimente streaming, session binding, backpressure și cancel semantics;
- compatibilitatea cu profilurile `ExecutionEnvironment` autorizate.

Dacă o capabilitate obligatorie lipsește, rularea se blochează înainte de orice editare. Un major/minor necunoscut este fail-closed. Un patch nou dintr-un interval compatibil este acceptat numai după contract smoke tests. `--allow-untested-engine` este permis pentru `doctor` și `compile` read-only sau pentru o rulare interactivă explicită, niciodată pentru un writer autonom. `resume` verifică profilul și versiunea adaptorului folosite la pornirea rulării.

## 13. Integrarea opțională cu ai-code-control

`ai-code-worker` trebuie să funcționeze cu `contextProvider: "none"`. Integrarea cu `ai-code-control` este un adaptor de proces care consumă JSON/exit codes, fără referințe de proiect sau acces direct la SQLite.

Fluxul providerului:

1. detectează explicit `ai-code-control` și configurația `.ai-code-control`;
2. rulează health și brief înainte de compilarea planului;
3. rulează find-symbol și impact-analysis pentru simbolurile identificate;
4. verifică versiunea hook-ului și rezoluția executabilului `ai-code-control` din worktree;
5. salvează existența, bytes și hash-ul manifestului local anterior;
6. materializează temporar un `current-plan.json` derivat mecanic din manifestul înghețat;
7. rulează scope verification direct și apoi commitul normal, cu hook-urile active;
8. restaurează exact manifestul anterior, indiferent dacă commitul trece sau eșuează;
9. exportă la final un rezumat redactat în locația canonică a proiectului;
10. rulează refresh numai după integrare, nu din worktree-urile paralele.

Invariante:

- `ai-code-control` oferă context și controale, nu conduce schedulerul;
- `ai-code-worker` oferă execuție și dovezi, nu devine memorie de produs;
- bazele SQLite ale celor două instrumente nu se citesc reciproc;
- absența ori defectarea providerului opțional produce fallback sau `BLOCKED` conform politicii proiectului;
- fișierul temporar `current-plan.json` dintr-un task worktree nu intră în commitul de business;
- `--no-verify`, un environment bypass și modificarea hook-ului instalat sunt interzise în fluxul autonom;
- trailerele commitului sunt audit metadata și pot fi validate de `commit-msg`, dar nu substituie scope verification din `pre-commit`;
- raportul final poate fi exportat în `.ai-code-control/handoffs/`, dar numai după redactare și printr-o regulă configurată.

## 14. Siguranță și autorizare

### 14.1 Permis implicit

- citire repository și documentație;
- editare numai în worktree și în `allowedPaths`;
- build, lint, typecheck și teste locale;
- containere și baze de date temporare declarate;
- commit-uri locale create de worker;
- branch-uri locale `aiw/*`;
- draft PR numai cu flag explicit și adaptor separat.

### 14.2 Interzis implicit

- deploy în orice mediu;
- push sau merge remote;
- force push;
- `git reset --hard`, `git clean -fdx`, ștergeri recursive largi;
- modificarea istoricului existent;
- migrații destructive sau ștergere baze de date;
- acces la secrete nedeclarate;
- schimbări de infrastructură sau upgrade-uri majore neincluse în plan;
- dezactivarea testelor, validărilor, hooks sau quality gates;
- folosirea `git commit --no-verify` sau a unui bypass echivalent;
- editarea unei migrații deja aplicate;
- executarea unui script nou din branch înainte ca politica să îl permită.

### 14.3 Procese și secrete

- fiecare proces rulează prin profilul `ExecutionEnvironment` autorizat, are timeout, limită de output și anulare a întregului process tree;
- variabilele de mediu sunt allowlist, cu valori injectate numai procesului care are nevoie;
- numele și valorile care arată ca tokenuri, parole, connection strings sau chei sunt redactate;
- argumentele și logurile redactate sunt hash-uite pentru corelare;
- raw conversations și stdout complet nu sunt memorie durabilă;
- accesul la rețea este o capabilitate declarată per task;
- comenzile cu efect extern cer o policy capability distinctă.

„Fără input” înseamnă că worker-ul finalizează singur numai ceea ce poate demonstra în limitele planului. Pentru cerințe neclare, permisiuni noi sau acțiuni externe produce `BLOCKED` cu dovezi.

### 14.4 Trust al instrucțiunilor

Policy-ul extern și `RunAuthorization` au autoritate peste manifest, plan, roluri și conținutul repository-ului. O sursă inferioară poate adăuga restricții, dar nu poate extinde permisiunile. Codul, documentația obișnuită, outputul comenzilor și conținutul extern sunt tratate ca date neîncrezătoare. `AGENTS.md` și `CLAUDE.md` pot cere verificări suplimentare, dar nu pot autoriza push, deploy, network-write, secrete sau extinderea scope-ului.

### 14.5 Run authorization

Planul `accepted` permite compilarea, nu scrierea. Writer-ul pornește numai după ce `authorization.json` este legat de repository fingerprint, plan hash, manifest hash, base commit, graph version și execution profile digest. Approval mode controlează dacă se poate cere un grant nou; nu acordă capabilități. Contractul complet este în [AICW-ADR-003](adr/0003-instruction-trust-and-run-authorization.md).

## 15. CLI și exit codes

Comenzi propuse:

```text
ai-code-worker init
ai-code-worker doctor [--engine codex|claude|all]
ai-code-worker compile <plan> [--allow-proposed]
ai-code-worker run <plan> --engine <engine>
ai-code-worker resume <run-id>
ai-code-worker status <run-id> [--json]
ai-code-worker cancel <run-id>
ai-code-worker verify <run-id>
ai-code-worker review <run-id>
ai-code-worker export <run-id> [--format report|patch|branch]
ai-code-worker cleanup <run-id> [--dry-run]
ai-code-worker rebuild-index
```

Exit codes:

| Cod | Semnificație |
|---:|---|
| 0 | operație finalizată / rulare DONE |
| 1 | utilizare sau configurație invalidă |
| 2 | quality gate ori review eșuat |
| 3 | rulare BLOCKED |
| 4 | conflict de lease/concurență |
| 5 | motor indisponibil/incompatibil |
| 6 | policy violation |
| 130 | anulare explicită |

Toate comenzile oferă `--json`. Mesajele de progres merg pe stderr, rezultatul mașină pe stdout.

## 16. Structura repository-ului ai-code-worker

```text
ai-code-worker/
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
├── LICENSE
├── CHANGELOG.md
├── schemas/
│   ├── project-config.schema.json
│   ├── manifest.schema.json
│   ├── agent-request.schema.json
│   ├── agent-result.schema.json
│   ├── review.schema.json
│   └── event.schema.json
├── src/
│   ├── cli/
│   ├── core/
│   ├── manifest/
│   ├── policy/
│   ├── git/
│   ├── runner/
│   ├── validation/
│   ├── review/
│   ├── persistence/
│   ├── redaction/
│   ├── integration/
│   ├── engines/codex/
│   ├── engines/claude/
│   └── context/ai-code-control/
├── templates/
│   ├── project/
│   ├── roles/
│   └── reports/
├── integrations/
│   ├── codex/
│   └── claude/
├── scripts/
└── tests/
    ├── unit/
    ├── integration/
    ├── contract/
    ├── e2e/
    └── fixtures/
```

TypeScript pe Node.js 22+ este alegerea pragmatică: ambele motoare au interfețe CLI ușor de controlat din procese copil, iar SDK-urile pot fi introduse ulterior în adaptoare. JSON Schema este contractul public; tipurile TypeScript se generează sau se verifică împotriva schemelor, nu le înlocuiesc.

## 17. Roadmap de implementare

Primele 10–15 zile lucrătoare sunt un `prototype timebox`, limitat la contracte, fake engine și un happy path controlat. Nu reprezintă estimarea pentru Definition of Done. Planificarea inițială este 2–3 săptămâni pentru Faza 0, încă 3–5 săptămâni pentru Faza 1 utilizabilă și aproximativ 3–5 luni pentru v1 cross-platform, dual-engine și validat prin pilot, cu reevaluare la fiecare gate.

### Faza 0 — contracte și harness determinist

Livrabile:

- repository separat și CI propriu;
- schemele JSON și fixtures valide/invalide;
- parser de config și plan metadata;
- `RunIntent`, `RunAuthorization` și instruction trust policy;
- state machines, graph version și event log cu sequence;
- contractele `ExecutionEnvironment`, `TaskInputSnapshot` și streaming `EngineEvent`;
- state root extern și detectarea sync roots/Git common directory;
- `doctor`, `compile`, `status`;
- runner fake de quality gates cu timeout, process-tree cancellation și redaction;
- policy engine pentru comenzi și căi;
- fixture repositories pentru Windows/Linux;
- motor și execution backend fake, fără consum de tokeni, pentru toate fluxurile deterministe.

Criteriu de ieșire: același plan produce același manifest normalizat și aceleași erori de validare, fără a modifica repository-ul fixture.

### Faza 1 — MVP single-engine, single-writer

Livrabile:

- adaptor Codex CLI;
- un singur task de scriere la un moment dat;
- backend `isolated` cu environment scrubbed, mounts/rețea/limite verificate;
- worktree și branch create de worker;
- authorization binding înainte de writer;
- dependency snapshot și input tree pentru fiecare task;
- verificare reală a diff-ului;
- worker-owned commit;
- integration worktree;
- global gates;
- usage evidence cu input uncached/cache-read/cache-write separate și bugete aplicate;
- clasificarea gate failures și retry-on-same-commit;
- reviewer read-only;
- criterion coverage matrix;
- compatibility profile fail-closed pentru adaptor;
- lease, heartbeat, idempotency și recovery minim după process kill;
- anulare sigură a process tree-urilor și cleanup conservator;
- bridge minimal de hook pentru pilotul consumer project, testat separat de core provider;
- raport `DONE/BLOCKED`;
- installer și skill Codex minimal.

Criteriu tehnic de ieșire: un plan mic este implementat end-to-end într-un repository fixture, iar încălcarea scope-ului, prompt injection-ul care cere capabilități noi, commitul făcut de agent, un gate roșu, un motor incompatibil, un hook failure și un crash în fiecare checkpoint major sunt blocate ori reluate fără commit duplicat.

### Pilot tehnic înaintea Fazei 2

După criteriul tehnic, worker-ul execută trei task-uri reale consumer project cu risc mic sau mediu, selectate la momentul pilotului. Acesta este un smoke/value gate preliminar și nu demonstrează singur economia produsului.

Înainte de primul task se aprobă `.ai-code-worker/pilot-baseline.json`, care fixează sursa baseline-ului și pragurile fără modificare post-hoc:

```json
{
  "schemaVersion": "1.0",
  "minimumDoneTasks": 2,
  "maximumConsecutiveWorkerCausedFailures": 2,
  "requiredComparableMetrics": [
    "elapsedTime",
    "humanActiveMinutes",
    "humanInterventions"
  ],
  "conditionalComparableMetrics": ["reportedCostUsd"],
  "thresholds": {
    "maximumElapsedTimeRatio": 1.5,
    "maximumReportedCostRatio": 1.5,
    "maximumHumanActiveMinutesRatio": 1.5,
    "maximumHumanInterventionsRatio": 1.5,
    "maximumHumanInterventionsPerTask": 1
  }
}
```

Baseline-ul folosește task-uri istorice comparabile sau o măsurare manuală acceptată. Fiecare raport este `valoare worker / valoare rută manuală`, astfel încât `1.5` înseamnă maximum 50% overhead. Când baseline-ul unei metrici este zero, raportul nu se inventează: se aplică plafonul absolut preregistrat, dacă există, sau rezultatul devine `REVIEW_REQUIRED`.

Costul intră în comparație numai când ambele rute au date monetare comparabile; altfel tokenii și costul raportat rămân informativi. Lipsa unei metrici obligatorii ori a costului care ar fi trebuit să fie comparabil produce `REVIEW_REQUIRED`, nu un succes inventat.

Rezultatul value gate-ului este:

- `PASS`: minimum două din trei task-uri sunt `DONE`, fără scope/gate bypass, iar fiecare raport obligatoriu și fiecare raport condițional disponibil este cel mult egal cu pragul preregistrat;
- `FAIL`: apar două eșecuri consecutive cauzate de worker, mai puțin de două task-uri ajung `DONE` sau se încalcă un guardrail de siguranță;
- `REVIEW_REQUIRED`: pilotul trece funcțional, dar cel puțin un raport de timp/cost/efort uman depășește pragul ori baseline-ul este insuficient.

Faza 2 pornește limitat numai după `PASS`. `FAIL` oprește roadmap-ul pentru remediere sau abandon, iar `REVIEW_REQUIRED` cere analiza explicită a sursei overhead-ului și un nou pilot delimitat; trecerea funcțională nu este bilet automat spre paralelism sau release stabil.

### Faza 2 — Claude și DAG paralel sigur

Livrabile:

- adaptor Claude Code headless;
- shims Claude skill/custom agents;
- scheduler DAG;
- detectarea suprapunerilor de glob și `concurrencyKeys`;
- contract freeze și task-uri contract-first;
- două worktree-uri paralele fără fișiere comune;
- integrare topologică și conflict report.
- aplicarea obligatorie a sync-root policy înaintea oricărui writer paralel.

Criteriu de ieșire: aceeași suită E2E rulează cu Codex și Claude, iar task-urile incompatibile nu pornesc în paralel.

**Status**: livrat pe branch `agent/phase2-claude-dag` (adaptor Claude, `run --engine claude`, scheduler DAG, detectarea suprapunerilor, integrare cu conflict report, aplicarea sync-root la dispecerizare). Vezi [docs/PHASE-2.md](PHASE-2.md) și [AICW-ADR-007](adr/0007-claude-adapter-and-dag-scheduler.md) pentru detalii și scope-ul redus deliberat (paralelism cuplat numai la motorul fake; motoarele reale rămân secvențiale în această fază).

### Gate de valoare extins înainte de release stabil

Se execută minimum opt task-uri și se țintește un eșantion de zece: cel puțin trei backend, trei frontend, două full-stack, unul cu migrare și unul care trebuie să ajungă legitim `BLOCKED`; categoriile se pot suprapune. Baseline-ul și pragurile sunt înghețate înaintea eșantionului. Un `BLOCKED` așteptat validează policy-ul, dar nu este numărat ca `DONE`. Rezultatul folosește aceleași verdicturi `PASS`, `FAIL`, `REVIEW_REQUIRED`; numai `PASS` permite afirmații de valoare și release readiness.

**Status**: pe pauză, condiționat de ridicarea îngheței de review manual de pe consumer project (repo consumator țintă pentru task-urile reale ale eșantionului). Cele 5 itemuri de robustețe/design descoperite prin dogfooding real în Faza 2 (verificare comportamentală a capacităților CLI, paralelism real pentru motoarele reale, gate-uri de task cu build/test real, backend `isolated` real, configurare adaptor din CLI) au fost închise înainte de Faza 3; vezi [todo.md](../todo.md).

### Faza 3 — repair, replanning și hardening avansat

Livrabile:

- review findings și repair task compiler;
- maximum repair cycles și repeated-failure detection;
- graph revisions, rulări `SUPERSEDED` și invalidarea descendenților;
- recovery pentru backend-uri remote și scenarii multi-host;
- export patch/branch/report;
- security/redaction tests.

Criteriu de ieșire: findings blocante generează repair attempts delimitate, reviziile nu mută manifestul înghețat, iar scenariile avansate de recovery păstrează proprietățile demonstrate în Faza 1.

### Faza 4 — adaptor ai-code-control și distribuție

Livrabile:

- provider `ai-code-control` exclusiv prin CLI JSON;
- health/brief/impact/scope/refresh în punctele corecte;
- export de handoff redactat;
- init/update cu blocuri administrate și versiuni;
- onboarding pentru submodule-ul de bootstrap/pilot și documentație de upgrade;
- matrice de compatibilitate Codex/Claude;
- pachete/plugin shims opționale.
- decizia canalului stabil: npm package, executable semnat, submodule/Git dependency suportat sau CLI extern plus config versionat.

Criteriu de ieșire: worker-ul funcționează identic fără `ai-code-control`, iar activarea providerului adaugă context și verificări fără a schimba manifest semantics.

### Faza 5 — SDK-uri și operare avansată, numai după stabilizare

- adaptoare Codex SDK / Claude Agent SDK;
- observabilitate OpenTelemetry fără conținut sensibil;
- draft PR adapter cu autorizare explicită;
- agent teams numai în experimente controlate;
- backend-uri remote/CI izolate;
- policy signing și provenance/SBOM.

Această fază nu este necesară pentru primul release stabil.

## 18. Strategia de testare

### 18.1 Unit

- validarea tuturor schemelor;
- tranziții permise/interzise ale stării;
- DAG cycle detection și ready-set;
- overlap de glob-uri și concurrency keys;
- normalizare path Windows/Linux și protecție path traversal;
- policy rules și command classification;
- redaction;
- repair budget și repeated-failure signatures;
- accounting separat pentru input uncached, cache read, cache write, output și cost;
- value-gate evaluation pentru `PASS`, `FAIL` și `REVIEW_REQUIRED`;
- event replay și snapshot reconstruction.

### 18.2 Contract tests pentru adaptoare

- argumentele CLI generate;
- parsing JSON/JSONL;
- timeouts, exit codes și procese întrerupte;
- lipsa capabilităților obligatorii;
- output invalid față de schemă;
- resume cu session ID valid/invalid;
- motor în interval testat, patch nou cu smoke test și major/minor necunoscut blocat;
- usage complet, parțial și necunoscut;
- motor fake pentru CI fără consum de modele.

### 18.3 Integration cu repository fixtures

- repository curat versus murdar;
- worktree create/reuse/cleanup;
- submodule prezent/absent;
- fișier permis și fișier în afara scope-ului;
- untracked, rename, delete și symlink/junction;
- agent care mută HEAD sau creează commit neautorizat;
- task gate verde/roșu/timeout;
- fail apoi pass pe același commit raportat `FLAKY`, nu `PASSED`;
- quarantine validă, expirată și fără owner/issue;
- manifest temporar per worktree, hook activ, commit fără `--no-verify` și restaurare exactă;
- Git common directory sub sync root cu writer secvențial versus paralel;
- cherry-pick curat și conflict;
- migrare nouă versus editarea uneia existente;
- două task-uri paralele compatibile/incompatibile.

### 18.4 E2E

- plan → manifest → task → commit → integrare → gates → review → DONE;
- finding blocant → repair → reverificare → DONE;
- trei repair cycles → BLOCKED;
- process kill în execuție, verificare și integrare → resume;
- Codex și Claude pe aceeași fixture și același contract de rezultat;
- worker fără ai-code-control;
- worker cu ai-code-control fake/real în CI dedicat.

### 18.5 Teste de securitate

- secret în env/output/diff;
- path traversal și glob escape;
- comandă destructive deghizată;
- output foarte mare;
- child process rămas activ;
- symlink către exteriorul worktree-ului;
- manifest modificat după freeze;
- event log trunchiat/corupt;
- două coordinatoare pe aceeași rulare;
- repository controlat care încearcă să modifice adapter settings.
- environment bypass sau `--no-verify` încercat de worker/agent.

## 19. Definition of Done pentru core v1

Release-ul v1 este gata numai dacă:

- rulează pe Windows și Linux;
- canalul stabil de distribuție este decis, versionat și reproductibil; submodulul rămâne suportat cel puțin pentru bootstrap/pilot;
- Codex și Claude trec aceeași suită de contracte;
- planul este compilat și validat înaintea oricărei editări;
- writer-ul pornește numai cu RunAuthorization legat de manifest, base, graph version și execution profile;
- toate procesele controlate de repository rulează prin `ExecutionEnvironment`, iar profilul autonom implicit este `isolated`;
- instrucțiunile din repository ori output nu pot extinde capabilitățile grantului;
- nicio scriere nu are loc în checkout-ul principal;
- starea operațională implicită nu este scrisă în repository ori într-un sync root;
- task-urile paralele nu pot deține căi ori resurse comune;
- paralelismul este blocat când Git common directory este într-un sync root interzis;
- agentul nu poate declara singur task-ul `PASSED`;
- commiturile sunt create de worker după scope și task gates;
- hook-urile proiectului rulează fără bypass, iar manifestele temporare nu intră în commit;
- integrarea pornește exact din base commit și este reproductibilă;
- fiecare task rulează dintr-un `TaskInputSnapshot` verificat și nu vede outputuri fără relație de dependență;
- DONE cere criterii acoperite, gate-uri verzi, review fără blockers și tree de integrare curat;
- fiecare criteriu are matrice explicită test/comandă/dovadă;
- usage evidence separă tokenii uncached/cache-read/cache-write și nu transformă necunoscutul în zero;
- BLOCKED conține cauza, ultima stare sigură și instrucțiuni de reluare;
- crash/resume nu dublează commituri sau task-uri;
- logurile și artefactele nu conțin secrete ori conversații brute;
- worker-ul funcționează cu `contextProvider: "none"`, fără `ai-code-control`;
- cleanup-ul nu șterge worktree-uri cu modificări ori commituri neexportate.
- Faza 2 limitată este inaccesibilă până când pilotul tehnic primește `PASS`, iar release-ul stabil este inaccesibil până când gate-ul de valoare extins primește `PASS`.

Profilul opțional `ai-code-control` are Definition of Done separată: numai CLI JSON/exit codes, fără acces direct la SQLite, compatibilitate de schemă fail-closed, hook lifecycle conform ADR-001 și aceleași manifest semantics ca în modul `none`. Eșecul acestui profil nu blochează release-ul core.

## 20. Riscuri și răspunsuri

| Risc | Răspuns |
|---|---|
| schimbări dese în CLI-urile AI | adaptoare versionate, `doctor`, contract tests și matrice de compatibilitate |
| versiune de motor netestată | fail-closed pentru writer, intervale validate și capability smoke tests |
| conflicte între agenți | worktree per task, ownership exclusiv, concurrency keys și integrare topologică |
| Git common directory sub OneDrive/sync root | state root extern, warning secvențial, blocarea paralelismului și clonă locală recomandată |
| succes fals declarat de model | worker-ul recalculează diff, gates, artefacte și criterii |
| cost/token explosion | paralelism mic implicit, bugete, timeout și repair limit |
| cache-ul distorsionează bugetul de input | bugete și evidence separate pentru uncached/cache-read/cache-write |
| checkout murdar al utilizatorului | blocare fără stash/reset automat |
| scurgere de secrete | env allowlist, redaction, output limit, fără transcript brut |
| plan vag | status accepted, coverage validation și BLOCKED pentru ambiguități materiale |
| testele validează aceeași presupunere greșită | reviewer separat și evidence mapping la criteriile planului |
| flaky test consumă repair loop | failure classifier, retry pe același commit și quarantine guvernată |
| repair loop infinit | limită, semnătură de eșec și oprire fără progres |
| poluarea repository-ului cu artefacte | runs/worktrees/cache gitignored și export explicit al raportului redactat |
| dependență circulară cu ai-code-control | provider de proces opțional, contract JSON și ownership separat |
| hook-ul scope-control blochează sau este ocolit | manifest per worktree, verificare directă, commit fără bypass și restaurare exactă |
| Git manipulat de agent | HEAD invariant, comenzi Git interzise agentului și commit controlat de worker |

## 21. Decizii care trebuie fixate prin ADR-uri în repository-ul ai-code-worker

1. separarea `ai-code-worker/` submodule de `.ai-code-worker/` project state;
2. CLI TypeScript și adaptoare de proces ca MVP;
3. manifestul înghețat și JSON Schema drept contract public;
4. event log append-only drept bază de recovery și SQLite rebuildable;
5. worktree per writer și integration worktree separat;
6. commiturile deținute de coordinator, nu de model;
7. review independent read-only și repair finit;
8. fără transcript brut și fără secrete persistate;
9. `ai-code-control` ca provider opțional prin CLI, fără code dependency;
10. nicio acțiune remote sau destructive implicită.
11. [AICW-ADR-001: scope authority și interoperabilitatea cu Git hooks](adr/0001-scope-hook-interoperability.md).
12. [AICW-ADR-002: medii de execuție și izolarea proceselor](adr/0002-execution-environments.md).
13. [AICW-ADR-003: trust al instrucțiunilor și autorizarea imutabilă a rulării](adr/0003-instruction-trust-and-run-authorization.md).
14. [AICW-ADR-004: snapshot-uri de dependențe și revizii de graf](adr/0004-dependency-snapshots-and-graph-revisions.md).
15. [AICW-ADR-005: protocol streaming pentru adaptoarele de motor](adr/0005-streaming-engine-adapter.md).
16. [AICW-ADR-006: recovery minim și idempotency înainte de pilot](adr/0006-minimum-recovery-before-pilot.md).

## 22. Ordinea pragmatică de pornire

Prima implementare nu trebuie să înceapă cu toți agenții. Ordinea recomandată este:

1. scheme pentru authorization, execution environment, engine events și task input snapshots;
2. state machine, event sequence și fake recovery;
3. instruction trust și policy engine;
4. quality-gate runner prin fake `ExecutionEnvironment`;
5. worktree/scope/commit control;
6. state root extern, sync-root detection și hook interoperability;
7. motor fake și repository fixtures;
8. plan compiler read-only și authorization binding;
9. dependency snapshot builder;
10. backend `isolated` și un writer Codex streaming, secvențial;
11. usage budgets, failure classifier și recovery minim;
12. integrare + global gates;
13. reviewer read-only și criterion coverage;
14. pilot tehnic consumer project;
15. Claude adapter și DAG paralel limitat;
16. gate de valoare extins;
17. repair/replanning avansat;
18. provider `ai-code-control` complet;
19. distribuție stabilă, SDK-uri și funcții avansate.

Nucleul valoros nu este numărul de agenți, ci lanțul de autoritate:

```text
plan acceptat
→ manifest valid și înghețat
→ authorization grant legat
→ dependency snapshot verificat
→ proces izolat
→ scope controlat
→ modificare verificată
→ commit controlat
→ integrare reproductibilă
→ gate-uri deterministe
→ review independent
→ DONE sau BLOCKED cu dovezi
```
