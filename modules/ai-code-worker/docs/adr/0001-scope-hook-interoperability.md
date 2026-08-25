# AICW-ADR-001: Scope authority și interoperabilitatea cu Git hooks

- Status: acceptat
- Data: 2026-08-01
- Owner: developer experience
- Domeniu: `ai-code-worker`, adaptoare de scope și Git commit lifecycle
- Plan asociat: [ai-code-worker — plan de implementare v1.2](../IMPLEMENTATION-PLAN.md)

## Context

`ai-code-worker` trebuie să creeze commituri numai după ce verifică manifestul înghețat, diff-ul real, căile permise și task gates. Unele repository-uri consumatoare au deja propriile hook-uri Git și propriul scope guard.

consumer project are un hook `.git/hooks/pre-commit` instalat de `ai-code-control`. Hook-ul rulează `verify-changed-files` folosind `.ai-code-control/reports/refactor/current-plan.json`. Un task worker executat într-un worktree va rula același hook, dar trebuie să îi prezinte scope-ul task-ului respectiv, nu manifestul activ din checkout-ul principal.

[Git worktree](https://git-scm.com/docs/git-worktree.html) păstrează componentele comune, inclusiv configurația și hook-urile implicite, în Git common directory partajat între worktree-uri. [Documentația Git hooks](https://git-scm.com/docs/githooks.html) precizează că hook-urile de commit rulează din root-ul worktree-ului, iar `pre-commit` rulează înainte ca mesajul commitului să fie pregătit și nu primește calea mesajului. Prin urmare, un trailer `run-id/task-id` nu poate autoriza verificarea pre-commit.

Fără o decizie comună apar patru riscuri:

1. hook-ul validează un manifest aparținând altui task și blochează un commit corect;
2. worker-ul ocolește hook-ul cu `--no-verify`, anulând o regulă a repository-ului;
3. două worktree-uri paralele concurează pentru un singur manifest global;
4. manifestul temporar sau schimbarea hook-ului ajunge accidental în commitul de business.

## Decizie

### 1. Autoritatea de scope

Manifestul înghețat al rulării `ai-code-worker` este autoritatea de orchestrare și scope pentru task. Un provider precum `ai-code-control` poate aplica reguli suplimentare, dar nu poate extinde `allowedPaths`, reduce `forbiddenPaths` sau schimba criteriile fără o revizie explicită a manifestului worker-ului.

Scope-ul efectiv este intersecția regulilor aplicabile:

```text
worker frozen manifest
∩ repository policy
∩ provider-specific restrictions
= effective writable scope
```

Orice contradicție care nu poate fi redusă sigur produce `BLOCKED`.

### 2. Detectarea hook-urilor

În preflight, worker-ul rezolvă prin Git:

- root-ul worktree-ului;
- Git directory privat al worktree-ului;
- Git common directory;
- `core.hooksPath` sau directorul implicit de hook-uri;
- hook-urile active pentru commit;
- executabilele și submodulele de care acestea depind.

Worker-ul nu înlocuiește, nu editează și nu dezactivează hook-urile repository-ului. Dacă un hook obligatoriu nu poate rula din worktree sau prin profilul `ExecutionEnvironment` autorizat, task-ul se blochează înainte de pornirea agentului. Hook-ul este cod controlat de repository și nu este ocolit de izolarea definită în [AICW-ADR-002](0002-execution-environments.md).

### 3. Materializarea manifestului per worktree

Pentru un provider care cere un fișier de scope în repository, adaptorul execută următoarea secvență:

1. determină locația cerută de provider;
2. salvează dacă fișierul exista, bytes exacți, metadata necesară și SHA-256;
3. generează determinist un manifest compatibil din task-ul înghețat;
4. scrie manifestul numai în worktree-ul task-ului;
5. include calea manifestului temporar în propriul `allowedFiles`, pentru ca scope guard-ul să nu se autoblocheze;
6. marchează artefactul ca orchestration-only și îl exclude explicit din staging;
7. rulează verificarea providerului direct înainte de `git commit`;
8. rulează commitul normal, astfel încât hook-urile să verifice din nou;
9. restaurează exact starea anterioară după succes sau eșec;
10. verifică bytes/hash și starea Git după restaurare.

Dacă fișierul nu exista, restaurarea înseamnă eliminarea exclusivă a fișierului temporar cunoscut. Dacă exista, restaurarea scrie exact bytes salvați. Orice incertitudine sau eșec de restaurare produce `BLOCKED`; worktree-ul este păstrat pentru diagnostic și nu este curățat automat.

Manifestul temporar nu este transferat între worktree-uri. Fiecare writer are propria copie și propriul task ID.

### 4. Commit lifecycle

Worker-ul:

- verifică mai întâi diff-ul complet față de task base;
- stage-uiește numai căile de business permise;
- confirmă că manifestul temporar și alte artefacte de orchestrare nu sunt staged;
- nu folosește `git commit --no-verify` și nu setează un environment bypass;
- permite tuturor hook-urilor repository-ului să ruleze;
- tratează un hook failure ca `POLICY_FAILURE` sau `INFRASTRUCTURE_FAILURE`, nu ca defect de business reparabil automat;
- salvează exit code-ul și outputul redactat în evidence.

Worker-ul poate adăuga trailere:

```text
AIW-Run: <run-id>
AIW-Task: <task-id>
AIW-Manifest-SHA: <sha256>
```

Acestea sunt audit metadata. Un hook `commit-msg` le poate valida, dar `pre-commit` nu le folosește drept autorizație.

### 5. Integrarea cu ai-code-control

Adaptorul `ai-code-control` comunică numai prin CLI JSON și exit codes. Nu citește direct SQLite și nu referențiază tipuri interne.

Maparea minimă din task-ul worker în `current-plan.json` include:

- schema version suportată de provider;
- task ID, owner, branch și base commit;
- status `active` pe durata verificării;
- `allowedFiles`, `allowedPatterns` și `forbiddenPaths`;
- validările și criteriile task-ului relevante providerului;
- run ID și hash-ul manifestului în câmpuri compatibile sau metadata sidecar, fără a rupe schema providerului.

Înainte de primul task real, contract tests fixează versiunile de schemă suportate. O versiune necunoscută se blochează fail-closed.

### 6. Concurență

Hook-ul partajat poate rula concurent dacă toate dependențele sale sunt reentrante, iar fiecare invocare citește numai fișiere din worktree-ul curent. Adaptorul trebuie să testeze această proprietate.

Orice provider care folosește o singură stare globală mutabilă, în afara worktree-ului, primește un `concurrencyKey` exclusiv și serializează commiturile. Worker-ul nu presupune că două hook-uri sunt parallel-safe numai pentru că procesele pot porni simultan.

Această regulă este separată de politica pentru directoare sincronizate: dacă Git common directory este sub un sync root blocat, writerii paraleli rămân interziși chiar dacă hook-ul este reentrant.

## Consecințe

### Pozitive

- repository-ul își păstrează propriile controale și hook-uri;
- worker-ul nu poate declara unilateral că un commit este sigur;
- fiecare worktree primește scope-ul corect al task-ului;
- task-urile paralele nu concurează pentru `current-plan.json`;
- commitul poate fi legat auditabil de manifestul înghețat;
- `ai-code-control` rămâne opțional și independent.

### Costuri

- adaptorul trebuie să implementeze backup/restaurare verificabilă;
- toolchain-ul cerut de hook trebuie disponibil în fiecare worktree;
- hook-urile nereentrante pot serializa commiturile chiar dacă implementarea a fost paralelă;
- schimbările de schemă ale providerului necesită profile de compatibilitate și contract tests.

## Alternative respinse

### `git commit --no-verify`

Respins: ocolește politica repository-ului și ar face worker-ul mai puțin sigur decât workflow-ul manual.

### Autorizarea prin trailer în pre-commit

Respins: `pre-commit` rulează înaintea pregătirii mesajului și nu primește commit message file. Trailerul rămâne util numai pentru audit sau `commit-msg`.

### Un singur current-plan global

Respins: produce coliziuni între worktree-uri și poate valida task-ul greșit.

### Modificarea hook-ului repository-ului la instalarea worker-ului

Respins: worker-ul nu trebuie să preia ownership asupra politicilor locale și nici să suprascrie hook chains existente.

### Acces direct la baza SQLite ai-code-control

Respins: creează dependență de implementare, coupling de versiune și încalcă separarea celor două produse.

### Doar verificarea internă a worker-ului

Respins: scope verification internă este obligatorie, dar nu înlocuiește controalele suplimentare impuse de repository.

## Failure policy

| Situație | Rezultat |
|---|---|
| schema providerului este necunoscută | `BLOCKED/POLICY_FAILURE` |
| hook-ul sau toolchain-ul său lipsește | `BLOCKED/INFRASTRUCTURE_FAILURE` |
| verificarea directă respinge diff-ul | `BLOCKED/POLICY_FAILURE` |
| hook-ul respinge commitul | `BLOCKED/POLICY_FAILURE`, fără repair automat de business |
| manifestul temporar apare staged | anularea commitului și `BLOCKED` |
| restaurarea exactă eșuează | `BLOCKED`, worktree păstrat |
| trailerul lipsește după commit | commit invalid pentru integrare; remediere controlată de worker |
| providerul este opțional și absent | continuare numai dacă policy permite `contextProvider: none` |

## Acceptance tests obligatorii

1. Două worktree-uri primesc manifeste diferite și hook-ul validează task-ul corect în fiecare.
2. Un fișier în afara scope-ului este respins atât de worker, cât și de provider.
3. Manifestul temporar nu apare în commit și bytes anteriori sunt restaurați exact.
4. Un fișier anterior inexistent este eliminat după commit fără a șterge alte date.
5. `--no-verify` și environment bypass sunt respinse de policy.
6. Hook failure nu consumă repair cycle și nu pornește un agent care modifică business code.
7. Toolchain-ul/submodulul lipsă sau incompatibilitatea cu execution profile-ul blochează task-ul înaintea agentului.
8. Un hook nereentrant serializează commiturile prin `concurrencyKey`.
9. Rularea fără `ai-code-control` funcționează când providerul este opțional.
10. Commitul integrabil conține trailerele așteptate și hash-ul manifestului corespunde artefactului înghețat.

## Implementare etapizată

- Faza 0: detectarea hook-urilor, modelul de scope authority, fake provider și acceptance tests 1–8;
- Faza 1: slice-ul minim `ai-code-control` necesar pilotului consumer project;
- Faza 4: providerul complet health/brief/impact/scope/refresh și exportul de handoff.
