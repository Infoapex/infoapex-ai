# Plan 2 — Testare și calificare RC peste 8/10

> Decizie 2026-09-14: plan aprobat pentru calificarea ulterioară cu izolare, nu pentru
> RC-ul intern trusted-host fără Docker. Scorul >=8,5/10 nu este revendicat de RC-ul
> local. Vezi [TODO](../../todo.md) și [profilul curent](../TRUSTED-HOST-RC.md).

Data: 2026-09-13

Status: APROBAT ca backlog amânat; testele de mai jos nu sunt declarate trecute

Dependență: [Planul 1 — Implementare](RC-HARDENING-IMPLEMENTATION-PLAN.md)

Continuare: [Planul 3 — Optimizare](POST-RC-OPTIMIZATION-PLAN.md)

## 1. Obiectiv și reguli

Calificăm profilul declarat al candidatului, nu toate utilizările imaginabile. Ținta
este >= 8,5/10, cu securitate și fiabilitate fiecare >= 9/10 și nicio dimensiune sub 8/10.
Scorul este evaluare inginerească documentată, nu certificare sau garanție universală.
Grila și pragurile sunt propuse acum și se aprobă în RC-00, înainte de rezultate.

Un gate critic eșuat nu poate fi compensat de documentație bună sau de o medie mare.
Nu există cerință de trei consumatori, două echipe ori 30 de zile. Testele pot fi
realizate de maintainer pe fixtures proprii, fără pretenția independenței evaluării.

Din auditul precedent știm doar: build TypeScript PASS, 26 teste selectate PASS,
reproducere Docker a problemei stdin și isolation-preflight BLOCKED pe profilul local.
Aceste observații nu sunt dovezi de calificare pentru candidatul care urmează.

## 2. Matricea obligatorie

| Axă | Propunere RC | Condiție |
|---|---|---|
| Host | Windows + Docker Linux containers; Linux + Docker Engine | medii curate x86_64, versiuni fixate |
| macOS/ARM64 | experimental în propunere | dacă politica P6 nu este schimbată explicit, macOS rămâne obligatoriu pentru publicare |
| Toolchain | generic Node; .NET + Next.js | imagini și dependențe pinned |
| Distribuție | ZIP și pachet npm instalat local/offline | ambele dacă sunt promise; publicarea npm necesită decizie separată |
| Provider | un provider primar explicit; al doilea numai dacă este suportat | aceeași suită per provider declarat |
| Rețea | deny build/test; rețea de servicii test; agent allowlisted | fără acces la producție |
| Repository | fixture mic, fixture multi-componentă, copie autorizată EuroCarScan | repository-ul original nu este ținta testelor distructive |
| Instalare | fresh, repeated, upgrade, rollback, uninstall | fără CLI-uri ascunse sau config din home-ul maintainerului |

Pe toate combinațiile obligatorii host × toolchain × distribuție rulăm instalare,
comenzi de bază, execuție hermetică și cleanup. Suita Docker negativă rulează pe fiecare
host obligatoriu; suita live pe fiecare provider declarat. Nu deducem o celulă netestată
din succesul alteia. Profilurile opționale sunt N/A doar prin decizia RC-00.

## 3. Catalogul de teste

Fiecare ID identifică o suită cu subcazuri enumerate în implementare. Fiecare rezultat
include intrările, așteptarea, observația, exit code și artifact digest. Un mock nu
înlocuiește testul real cerut în coloana de mediu.

### Transport, filesystem și lifecycle

| ID | Scenariu / mediu | Acceptare |
|---|---|---|
| T01 | stdin/EOF, Unicode, input gol și mare; container real fără LLM | digest-ul inputului este identic; stream JSON necorupt; input depășit respins explicit |
| T02 | descoperire executabil host/container; Windows și Linux | containerul folosește CLI-ul său, fără cale host sau fallback |
| T03 | spații, Unicode, cwd, config HOME temporar și metadate Git | task-ul vede numai căi mapate; git necesar funcționează fără montarea writable a repo-ului original |
| T04 | citire/scriere în afara mount-urilor; fixture secret în afara lor | inaccesibil; nu folosim o cale greșită a fixture-ului ca dovadă |
| T05 | symlink, junction, traversal, mount și export de patch malițios | refuz determinist; zero scrieri în afara țintei; politicile/evidence protejate |
| T06 | modificare HEAD și fișiere utilizator între start și apply | rezultat neaplicat automat; conflict explicabil; conținutul utilizatorului păstrat |
| T07 | timeout/idle/cancel cu procese copil și proces care ignoră semnalul | containerul identificat este oprit și eliminat; fără procese task supraviețuitoare |
| T08 | OOM, PID/output/scratch limits, exit code și watchdog suprapus | limita mai strictă respectată; bounded evidence; motivul opririi corect |
| T09 | crash orchestrator, Docker restart, lease stale și cleanup repetat | recovery idempotent; fără dublarea efectelor sau ștergerea resurselor străine |

T04–T09 folosesc numai resurse temporare nominalizate și date sintetice. Testele de
resurse au limite mici; nu executăm fork bombs sau teste pe fișiere reale sensibile.
Container ID + run/task labels + registrul host se verifică înainte de cleanup.

### Rețea, secrete și căi MCP

| ID | Scenariu / mediu | Acceptare |
|---|---|---|
| T10 | endpoint local permis/interzis prin proxy real; config alterată | permisul reușește, interzisul e respins; hash-ul configurației efective verificat |
| T11 | direct IPv4/IPv6, DNS, CONNECT, redirect, host gateway, metadata și proxy oprit | căile interzise nu funcționează; indisponibilitatea proxy nu activează direct internet |
| T12 | rețea cu container suplimentar, proxy URL diferit, etichete falsificate | profilul este refuzat sau abaterea impusă prin control verificabil; etichetele singure nu produc PASS |
| T13 | credențiale sintetice în provider/build/tests/MCP/logs/archive | build/test și MCP de context nu le primesc; nicio valoare în artefacte; riscul din propriile tool-uri provider declarat corect |
| T14 | script de instalare dependențe și exfiltrare simulată | execuție izolată; fără token larg de registry sau host access; limitele egress respectate |
| T15 | toate entry points run_validation/guard/preflight/review/docs | repository code executat numai în runnerul autorizat, niciun spawn host neautorizat |
| T16 | MCP context încearcă execuție sau acces la alt proiect | acces refuzat; scope și buget aplicate independent de instrucțiunile LLM |
| T17 | Docker lipsă/indisponibil și policy modificată de task | fail-closed; fără degradare la host și fără policy writable devenită autoritate |

Testele negative folosesc endpoint-uri controlate, nu sisteme terțe atacate. Lipsa
internetului nu dovedește un deny: T10 verifică și un control pozitiv în aceeași topologie.
Fiecare subcaz critic T04–T17 rulează de minimum 5 ori; cancellation/recovery T07/T09
rulează 20 de cicluri. Flakiness de securitate/lifecycle blochează candidatul.

Pentru profilul RC restricted-agent-egress, T13 nu pretinde că un proces poate ascunde
propria variabilă de mediu de toate subprocess-ele sale. Dacă se promite credential
isolation strictă, adăugăm proba de broker/tool separation și aceasta devine obligatorie.

### Instalare și flux funcțional

| ID | Scenariu | Acceptare |
|---|---|---|
| T18 | instalare curată din ZIP și npm, în afara checkout-ului | fără dependențe accidentale de checkout/home; toate comenzile promise funcționează |
| T19 | instalare repetată, spații/Unicode, permisiuni refuzate, Docker lipsă | idempotent; erori utile; nicio escaladare globală de permisiuni |
| T20 | upgrade, backup alterat, rollback și utilizator care schimbă un fișier managed | backup verificat; rollback refuză overwrite neaprobat; datele utilizatorului păstrate |
| T21 | uninstall, întrerupere în provisionare, rerun | se elimină numai resursele proprii; lipsa cleanup-ului este raportată, nu ascunsă |
| T22 | propunere → inspect/accept → worker → validare → review → rezultat | toate tranzițiile și criteriile legate de run/task/commit; fără acceptare implicită |
| T23 | plan invalid, dependențe de task, repair limitat, retry/resume | fără execuție pentru plan invalid; retry bounded; efecte externe nedublate |
| T24 | memorie, index structural, impact, trace freshness și surse lipsă | stale detectat; fără fallback prezentat ca evidence echivalent; cache reconstruibil |
| T25 | generare docs, review fără scriere și UI de evidence | modificări numai prin calea permisă; UI bounded; fără payload sensibil |
| T26 | buget depășit, provider indisponibil, 429/timeout/auth invalid | oprire/pauză corectă; consum raportat; fără schimbare implicită de provider/model |

T22–T26 au fixtures deterministe și teste de contract; acestea nu țin locul T34 live.
O parte a verificării memoriei și trasabilității este code-specific; nu cerem grafului
să inventeze relații sau simboluri inexistente. `graph-drift --fail-on-review` este gate
când sursele trace au fost declarate și ingerate pentru candidatul respectiv.

### Supply chain, documentație și calificare

| ID | Scenariu | Acceptare |
|---|---|---|
| T27 | inventar SBOM npm/NuGet/imagini comparat cu artefactele | dependențe directe/tranzitive acoperite; versiuni/purl și relații; scanări datate |
| T28 | GO untracked/modificat, policy manifest incomplet, hash/commit fals | toate respinse; fișierele obligatorii și blob-urile Git exacte sunt validate |
| T29 | construire artefact de două ori și verificare provenance/atestări | bytes reproductibili pentru ZIP/package când acesta e contractul; imaginile verificate prin digest, nu declarate bit-reproducibile fără dovadă |
| T30 | workflow pe runner curat, prerelease vs stable, fără GO și tag greșit | provisionare explicită; publicarea refuzată fără autoritate; prerelease marcat corect |
| T31 | evidence vechi, versiune greșită, rezultat incomplet, bundle alterat | calificarea refuzată; nu se transformă PENDING/INCONCLUSIVE în PASS |
| T32 | quickstart exact din README și troubleshooting pe erori simulate | fără pași ascunși; fiecare eroare are remediere; licență și matrice consistente |
| T33 | revizie a contractelor, documentelor și statusurilor | un singur adevăr pentru starea candidatului; toate limitările materiale publicate |
| T34 | task-uri reale LLM pe fixture și copie EuroCarScan autorizată | eșantion și buget conform secțiunii 4; calitate fără incidente de securitate |
| T35 | 3 cicluri complete install → run → recovery → uninstall pe fiecare host | același artefact, fără curățare manuală intermediară necesară pentru succes |
| T36 | re-review, scorecard și decizie finală | toate gate-urile critice PASS, scor și minime respectate, publicarea încă separată |

T30 se testează prin harness, fork/test repository privat autorizat sau mod dry-run;
nu publicăm pentru a proba că suntem pregătiți de publicare. Atestările care necesită
identitate CI reală se verifică în mediul autorizat și rămân PENDING dacă nu sunt produse.

## 4. Pilot live mic și reproductibil, nu pilot de adopție

După trecerea testelor fără LLM, aprobăm providerul/modelul, metoda de autentificare,
repositorii/fixtures, limita de bani sau consum măsurabil, numărul de invocări și timeout-ul.
Fără aprobare nu rulăm T34 și nu declarăm RC_QUALIFIED.

- 8 task-uri preregistrate per provider suportat, câte 3 repetări: 24 observații.
- Task-uri: bug local; refactor cu comportament păstrat; implementare multi-fișier;
  schimbare API+test; frontend+test; documentație; repair pornind de la test failing;
  reluare după întrerupere controlată. Fiecare are criterii și evaluator determinist.
- Maximum un ciclu repair per observație; retry de infrastructură înregistrat separat,
  fără eliminarea observațiilor nefavorabile. Seed/config fixate unde sunt disponibile.
- Prag propus: cel puțin 22/24 rezultate acceptate per provider, zero încălcări de scope,
  zero secrete expuse și zero efecte externe neautorizate. Nu mascăm un defect sistematic
  al unei clase de task prin media totală; orice asemenea defect blochează acea promisiune.
- Toate eșecurile au clasificare și evidence; un task incomplet nu poate fi raportat DONE.
  Se măsoară first-pass separat de succesul după repair.
- Dacă bugetul se termină, rezultatul este INCONCLUSIVE, nu se reduce retrospectiv lotul.

Acesta este un semnal de funcționare pe profilul testat, nu demonstrarea statistică a
ratei de succes generale. Un provider secundar netestat rămâne experimental/dezactivat.
EuroCarScan se folosește într-o copie/snapshot aprobat; datele reale și credențialele
de producție nu intră în fixtures. Pentru două providere suportate sunt 48 observații,
plus invocările de plan/review/repair; estimarea costului include întregul flux.

## 5. Evidence și rezultate

Registru propus, de implementat în RC-06; directoarele nu sunt create de acest plan:

```text
validation/rc/<candidate>/<run-id>/
  environment.json
  artifact-manifest.json
  test-results.json
  isolation-summary.json
  live-summary.json
  scorecard.json
  gate-decision.json
```

Schema raportului include: candidate/version, commit complet, test definition hash,
artefact SHA-256, image manifest digest și platformă, policy/config hash, versiuni de
runtime/provider, timestamps UTC, test IDs, comandă redactată, rezultat și evidence hashes.
Publicabilitatea fiecărui fișier se clasifică înainte de upload; căile personale,
codul privat, secretele și transcripturile brute nu sunt evidence public.

Stări: PASS, FAIL, BLOCKED, INCONCLUSIVE, SKIPPED, NOT_APPLICABLE. Doar PASS închide
un gate obligatoriu. NOT_APPLICABLE cere justificare de scope aprobată anterior.
Un test care acceptă Docker absent dovedește fail-closed, nu backend Docker funcțional.

Dacă se schimbă codul, imaginea, policy, dependențele sau harness-ul relevant, evidence-ul
afectat se invalidează. Matricea de dependențe decide reexecutarea; la candidatul final
rulăm și regresia completă obligatorie. Nu reluăm live costisitor după o editare cosmetică
fără impact demonstrat, dar păstrăm exact legătura evidence–intrări.

## 6. Blocaje absolute pentru calificare

- Orice defect critic/ridicat aplicabil în securitate, integritate, pierdere de date,
  permisiuni, publicare neautorizată sau execuție în afara profilului.
- Orice gate obligatoriu FAIL/BLOCKED/INCONCLUSIVE/SKIPPED ori celulă de suport netestată.
- Lipsa dovezii că transportul real, autentificarea, task-ul și cleanup-ul funcționează.
- Orice credențială reală în evidence, leak între proiecte sau modificare neautorizată.
- Artefacte fără trasabilitate la commit/config/imagine sau publicare fără GO valid.
- Lipsa criteriilor de scor de mai jos. Un scor nu anulează niciun blocaj de mai sus.

Defectele medii pot rămâne numai dacă nu afectează un gate obligatoriu și au limitare,
workaround, owner și termen documentate. O vulnerabilitate raportată ca neaplicabilă
cere analiză verificabilă; nu este eliminată din raport doar pentru a trece pragul.

## 7. Grila de scor

Fiecare dimensiune are cinci criterii, fiecare notat 0, 1 sau 2:

- 0: absent, defect sau fără dovezi relevante.
- 1: implementat parțial / testare incompletă ori limitare materială documentată.
- 2: criteriul complet pentru profilul declarat, cu probe pozitive/negative adecvate,
  evidence actual și review documentat; unde e relevant, probe de pe mediu curat.

Nota dimensiunii este suma celor cinci criterii, maximum 10. NOT_APPLICABLE nu primește
automat punctaj; RC-00 trebuie să definească un criteriu relevant echivalent, înaintea
testelor. Nu majorăm nota doar pentru numărul de fișiere, teste sau documente.

| Dimensiune | Pondere | Cele cinci criterii evaluate | Minimul RC |
|---|---:|---|---:|
| Securitate și izolare | 25% | filesystem/policy; network; secrete; MCP/host execution; resurse/cleanup | 9 |
| Funcționalitate și fiabilitate | 25% | transport/task real; plan/criterii; recovery/idempotence; lifecycle fără pierderi; erori/bugete | 9 |
| Testare și evidence | 20% | matrice curată; negative reale; trasabilitate; supply-chain/release integrity; re-review/repetabilitate | 8 |
| Instalare și documentație | 15% | onboarding; permisiuni explicate; diagnostic; README/contracte; upgrade/uninstall documentate | 8 |
| Mentenabilitate | 10% | limite module; policy source of truth; contract/versioning; regresii/module provenance; disciplină de actualizare | 8 |
| Eficiență și operare | 5% | consum măsurat; bugete/stop; context bounded; execuții fără duplicări inutile; retenție/diagnostic bounded | 8 |

Formula: `score = 0.25*S + 0.25*F + 0.20*T + 0.15*D + 0.10*M + 0.05*E`.
Acceptare numai dacă `score >= 8.5`, `S >= 9`, `F >= 9`, toate celelalte >= 8 și toate
blocajele sunt închise. Pragul se verifică înainte de rotunjire.

Exemplu, NU rezultat: S=9, F=9, T=9, D=9, M=8, E=8 => **8,85/10**.
Un S=7 cu alte note 10 este tot NO_GO, indiferent de medie.
Scorul inițial nu este completat automat; evaluăm baseline-ul și candidatul cu aceeași
grilă. Re-review-ul poate fi făcut de același maintainer într-o sesiune separată, cu
limitarea de independență consemnată.

## 8. Succesiune și efort

1. În RC-00: înghețăm matricea, definițiile de test, grila, bugetele și politica de date.
2. În RC-01–RC-07: scriem regresia înaintea fiecărui fix și rulăm subsetul relevant.
3. În RC-08: suite complete, Docker real și testele negative; apoi T34 cu buget aprobat.
4. Construim/verificăm candidatul final, executăm T35 și re-review T36; producem NO_GO
   sau RC_QUALIFIED cu scor și limitări.
5. Un GO ulterior autorizează publicarea acelui candidat; publicarea nu se deduce din testare.

Calificarea finală: 4–6 zile de lucru estimate, deja incluse în RC-08; remedierile ample
revin în pachetul de implementare afectat. Testele live se opresc la buget, nu continuă
automat până când apare un rezultat favorabil.
