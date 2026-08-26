# ADR-0001: Limita sigură pentru handoff-ul local

- Status: acceptat
- Data: 2026-08-26
- Owner: Infoapex AI
- Contracte asociate: `schemas/integration-config.schema.json`, `schemas/handoff.schema.json`

## Context

În modul `integrated`, planner-ul, worker-ul și CLI-ul rădăcină schimbă mesaje prin
fișiere. Valorile `handoffRoot` și `runId` ajung astfel în operații de filesystem.
Validarea doar la nivel de tip TypeScript sau concatenarea lexicală a segmentelor nu
este o limită de securitate: un path absolut, `..`, un nume special Windows ori un
symlink/junction poate devia citirea sau scrierea în afara repository-ului.

Payload-ul și output-ul unui agent sunt date neîncrezătoare. Configurația instalată,
schemele versionate și această regulă de rezoluție formează limita de încredere.

## Decizie

### Rădăcina canalului

Rădăcina canonică a repository-ului este limita maximă permisă. `handoffRoot`:

- este obligatoriu un path relativ, nevid;
- nu poate conține segmente `..`, forme absolute POSIX/Windows, UNC/device paths,
  separatori alternativi care schimbă semantica sau prefixe drive/volume;
- trebuie să rezolve lexical sub repository;
- trebuie să rămână sub repository și după rezoluția canonică a celui mai apropiat
  strămoș existent;
- este respins dacă un symlink ori junction ar produce o evadare din repository.

Nu se normalizează silențios o valoare periculoasă într-una acceptabilă. Configurația
invalidă oprește operația înainte de orice acces la filesystem.

### Identitatea rulării

`runId` este un singur segment ASCII, cu lungime între 1 și 128 și forma
`[A-Za-z0-9._-]+`. Sunt respinse explicit `.` și `..`, separatorii, NUL, sintaxa de
drive și numele de dispozitive rezervate de Windows. Validarea are loc înainte de
orice citire, creare de director sau scriere.

Un mesaj poate exista numai la calea fixă:

```text
<repository>/<handoffRoot>/<runId>/<direction>.json
```

unde `direction` este definit de schema handoff. După crearea directoarelor, limita
canonică este verificată din nou pentru a reduce riscul unui schimb de path între
verificare și utilizare.

### Publicare imutabilă

Înainte de publicare sunt validate configurația, payload-ul obiect și întregul
envelope conform schemelor JSON versionate. Publicarea:

1. creează în același director un fișier temporar exclusiv (`create-new`), cu
   permisiuni restrictive;
2. scrie conținutul complet și îl sincronizează;
3. publică atomic la numele final numai dacă acesta nu există deja;
4. curăță fișierul temporar atât la succes, cât și la eroare.

Un handoff publicat este imutabil. O a doua publicare cu aceeași identitate eșuează;
nu suprascrie și nu îmbină date.

### Consum fail-closed

Citirea folosește aceeași rezoluție sigură. JSON-ul este validat integral, iar
`runId` și `direction` trebuie să coincidă exact cu solicitarea. Planner-ul nu
consumă un feedback nepotrivit. Descoperirea worker-ului ignoră intrările invalide,
dar nu le transformă în comenzi sau autorizații.

## Consecințe

- Configurațiile normale relative rămân compatibile.
- Configurațiile ambigue sau care ieșeau din repository sunt intenționat respinse.
- Handoff-ul este un canal de date, nu o sursă de autoritate; nu poate extinde scope,
  capabilități ori autorizația rulării.
- Contenția concurentă are un câștigător determinist și nu produce mesaje parțiale.

## Alternative respinse

- `path.join()` plus un regex pentru `runId`: nu tratează căile absolute, linkurile și
  diferențele Windows/POSIX.
- Validare exclusiv în JSON Schema: schemele nu pot demonstra containment canonic.
- `writeFile` cu suprascriere: permite pierderea provenienței și stări concurente
  nedeterministe.
- Acceptarea feedback-ului pe baza numelui de fișier: nu verifică identitatea din
  envelope.

## Criterii de acceptare

1. Teste pozitive acoperă handoff-ul planner -> worker și worker -> planner.
2. Traversarea, path-urile absolute, UNC/device/drive, numele rezervate și `.`/`..`
   sunt respinse pe Windows și POSIX.
3. Un symlink/junction care iese din repository este respins înainte de acces.
4. O destinație existentă nu este suprascrisă.
5. Un envelope cu schemă, direcție sau `runId` nepotrivit nu este consumat.
6. După o eroare nu rămâne un mesaj final parțial.
