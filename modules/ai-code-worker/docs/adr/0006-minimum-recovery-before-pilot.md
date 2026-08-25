# AICW-ADR-006: Recovery minim și idempotency înainte de pilot

- Status: acceptat
- Data: 2026-08-01
- Owner: developer experience
- Plan asociat: [planul de implementare v1.2](../IMPLEMENTATION-PLAN.md)

## Context

Planul declară worker-ul reluabil și cere ca `DONE` să fie demonstrabil. Un pilot real poate fi întrerupt de process kill, restart, suspendarea sistemului, crash al motorului sau coruperea ultimei scrieri. Dacă lease, reconciliere și idempotency sunt implementate numai după pilot, task-urile reale rulează fără proprietatea de siguranță promisă.

Nu este necesar întregul repair engine înainte de pilot, dar efectele deja produse trebuie identificate fără duplicate sau cleanup distructiv.

## Decizie

Faza 1 include un recovery kernel minim.

### Event log și checkpoints

- Fiecare event are sequence monoton și ID unic.
- Append-ul este durabil înainte ca efectul următor să fie autorizat.
- Snapshot-ul este regenerabil din event log.
- Un tail trunchiat este detectat și ignorat numai dacă ultima înregistrare poate fi demonstrată incompletă; corupția anterioară produce `BLOCKED`.
- Checkpointurile sigure sunt după manifest freeze, task input freeze, task verification, commit creation, integration commit și gate completion.

### Lease

Lease-ul conține run ID, host fingerprint, PID, process start time, coordinator instance ID și heartbeat. PID-ul singur nu este suficient din cauza reutilizării.

Un al doilea coordinator:

- refuză rularea cât timp lease-ul este valid;
- nu șterge lease-ul expirat automat;
- intră în `RECOVERING` numai prin comanda `resume`;
- persistă motivul preluării și rezultatul reconcilierii.

### Reconciliere

La resume se verifică:

- manifestul și authorization hash;
- execution profile;
- worktree-urile și Git common directory;
- branch, HEAD, index, diff și untracked files;
- commiturile worker-owned și trailerele;
- integration state și gate evidence;
- procese ori resurse rămase active.

O stare ambiguă produce `BLOCKED/RECOVERY_AMBIGUOUS`. Worker-ul păstrează worktree-ul și instrucțiunile de diagnostic.

### Idempotency

Operațiile cu efect au chei stabile, de exemplu:

- `create-worktree:<run>:<task>:<attempt>`;
- `verify-task:<input-tree>:<diff-digest>`;
- `create-commit:<task>:<verification-digest>`;
- `integrate:<dependency-snapshot>:<task-commit>`;
- `run-gate:<commit>:<gate-config-digest>`.

Repetarea unei chei întoarce efectul verificat existent sau blochează la nepotrivire. Nu creează automat alt commit.

### Procese și cleanup

Fiecare proces este asociat cu execution environment și process-tree identity. Cancel și timeout termină arborele. După crash, backendul izolat trebuie să poată identifica și opri resursele rulării fără a atinge alte rulări.

Cleanup-ul nu elimină worktree-uri cu diff, untracked files, commituri neintegrate sau evidence nereconciliat. Implicit produce dry-run report.

## Delimitare față de repair

Înainte de pilot sunt obligatorii recovery, resume la checkpoint și protecția anti-duplicate. Compilarea automată a repair task-urilor, replanning complex și strategiile avansate de retry pot rămâne în Faza 3.

## Consecințe

- Faza 1 crește, dar pilotul testează produsul descris, nu un happy path fragil.
- State machine-ul adaugă `RECOVERING` și terminalul `SUPERSEDED`.
- Resursele pot fi marcate `ORPHANED` până la reconciliere.
- `resume` este fail-closed la incertitudine.

## Alternative respinse

- Recovery numai în Faza 3: contrazice pilotul pe task-uri reale.
- Reexecutarea automată a task-ului `RUNNING`: poate dubla efecte și cost.
- Cleanup agresiv după lease expirat: poate pierde modificări sau dovezi.

## Acceptance tests

1. Process kill în fiecare checkpoint major permite resume fără commit duplicat.
2. PID reutilizat nu este confundat cu coordinatorul anterior.
3. Event tail trunchiat este detectat; corupția internă blochează.
4. Un commit existent cu aceeași idempotency key este reutilizat numai dacă digesturile coincid.
5. Un worktree murdar sau cu commit neexportat supraviețuiește cleanup-ului.
6. O stare Git ambiguă produce `BLOCKED/RECOVERY_AMBIGUOUS` cu instrucțiuni de reluare.
