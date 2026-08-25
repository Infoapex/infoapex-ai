# AICW-ADR-004: Snapshot-uri de dependențe și revizii de graf

- Status: acceptat
- Data: 2026-08-01
- Owner: developer experience
- Plan asociat: [planul de implementare v1.2](../IMPLEMENTATION-PLAN.md)

## Context

Un DAG descris numai prin `dependsOn` nu garantează că filesystem-ul unui task conține rezultatele dependențelor sale. Dacă fiecare worktree pornește direct din base commit, consumatorii nu văd contractele sau implementările produse anterior. Dacă pornesc dintr-un branch de integrare global, pot vedea și rezultate fără relație de dependență.

Manifestul este înghețat înainte ca output commiturile task-urilor să existe. Snapshot-ul concret trebuie deci rezolvat ca artefact runtime, fără a muta în tăcere manifestul.

## Decizie

### TaskInputSnapshot

Înainte ca un task să devină `READY`, worker-ul creează `tasks/<task-id>/task-input.json` conform schemei publice.

Snapshot-ul conține:

- `runId`, `taskId` și `graphVersion`;
- `rootBaseCommit`;
- dependențele directe în ordinea declarată normalizată;
- closure-ul tranzitiv în ordine topologică stabilă;
- commiturile verificate ale dependențelor;
- `inputCommit` materializat de worker;
- `inputTree` Git;
- `snapshotMetadataSha256` calculat peste JSON canonic fără propriul digest;
- versiunea algoritmului de compunere.

`inputTree` este identitatea conținutului Git. Digestul SHA-256 protejează metadatele și ordinea, fără a presupune algoritmul de obiecte folosit de repository.

### Construire

1. Toate dependențele directe trebuie să fie `PASSED` și să aibă commit verificat.
2. Worker-ul calculează closure-ul tranzitiv.
3. Commiturile sunt aplicate într-o ordine topologică stabilă, cu tie-break după task ID.
4. Un commit prezent prin mai multe ramuri este aplicat o singură dată.
5. Se verifică invarianta că tree-ul rezultat conține toate expected artifacts ale dependențelor.
6. Snapshot-ul se scrie înainte de crearea worktree-ului writerului sau ca primul artefact read-only al acestuia.

Task-urile fără relație de dependență nu intră în snapshot, chiar dacă au fost deja integrate în alt worktree.

### Conflicte

Un conflict în compunerea snapshot-ului produce `BLOCKED/DEPENDENCY_CONFLICT`. Worker-ul nu inventează o rezolvare de business. Un task de integrare poate fi introdus numai printr-o revizie autorizată a grafului.

### Revizii și invalidare

Manifestul înghețat este imuabil. O schimbare de graf, scope, criterii sau dependențe creează o rulare nouă cu:

- `graphVersion` incrementat;
- `supersedesRunId` către rularea anterioară;
- grant și manifest hash noi.

În aceeași rulare, un repair care schimbă commitul unei dependențe invalidează snapshot-urile descendenților. Descendenții devin `STALE`, apoi primesc snapshot și attempt noi. Task-urile fără cale de dependență față de repair nu sunt invalidate.

## Consecințe

- DAG-ul devine verificabil în filesystem, nu numai în manifest.
- Integrarea globală și inputul unui task sunt concepte distincte.
- Evidence poate demonstra exact ce cod a văzut fiecare agent.
- Schedulerul trebuie să gestioneze `STALE` și rebuild determinist.

## Alternative respinse

- Toate worktree-urile din base commit: dependențele nu sunt vizibile.
- Toate worktree-urile din branch-ul de integrare curent: introduce outputuri fără dependență și nondeterminism temporal.
- Numai lista commiturilor fără `inputTree`: nu demonstrează rezultatul materializat.

## Acceptance tests

1. `BACKEND-01` vede outputul `CONTRACT-01` și nu vede un task frontend independent.
2. Același closure produce aceeași ordine, `inputTree` și digest pe două rulări fixture.
3. Un diamond dependency nu aplică de două ori același commit.
4. Un conflict produce `BLOCKED/DEPENDENCY_CONFLICT` fără modificarea manifestului.
5. Un repair invalidează numai descendenții tranzitivi.
6. O revizie de graf creează alt run ID, graph version și authorization binding.
