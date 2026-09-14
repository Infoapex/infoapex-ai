# Plan 1 — Consolidarea Infoapex AI pentru primul RC calificat

> Decizie 2026-09-14: plan aprobat și amânat pentru etapa de izolare de după RC-ul
> intern trusted-host. Nu blochează RC-ul fără Docker. Vezi [TODO](../../todo.md)
> și [profilul RC curent](../TRUSTED-HOST-RC.md). Criteriile de mai jos rămân pentru
> calificarea ulterioară, nu sunt declarate îndeplinite prin schimbarea scope-ului.

Data: 2026-09-13

Status: APROBAT ca backlog amânat; fără autorizare de publicare

Baseline auditat: `dc0d8c8`, package `1.0.0-rc.1-internal`

Profil: solo-maintainer, local, un repository autorizat; utilizare corporate controlată

Țintă: RC calificat tehnic, scor demonstrat >= 8,5/10 pe grila din Planul 2

Documente asociate:

- [Planul 2 — Testare, dovezi și scor](RC-VALIDATION-AND-SCORING-PLAN.md)
- [Planul 3 — Optimizare după baseline-ul RC](POST-RC-OPTIMIZATION-PLAN.md)
- [Planul P6 existent](INFOAPEX-AI-P6-PRODUCTION-READINESS-PLAN.md)
- [Profilul solo existent](../P6-SOLO-PROFILE.md)

## 1. Rezultatul și limitele angajamentului

Un utilizator trebuie să poată instala un artefact identificabil, configura drepturile,
executa un task real în mediul suportat, valida rezultatul în izolare, relua sau anula
execuția și inspecta dovezile. Release-ul nu trebuie să depindă de configurații ascunse
de pe calculatorul maintainerului.

Acest plan nu declară produsul certificat corporate și nu promite compatibilitate cu
orice tool. Agentul principal din VS Code, administratorul hostului și administratorul
Docker sunt componente de încredere, în afara izolării workerului. Codul trimis unui
serviciu LLM părăsește mașina conform politicii organizației; Docker nu schimbă asta.

Nu cerem trei repository-uri consumatoare, două echipe, 30 de zile sau audit extern
pentru RC-ul solo. Fixtures locale distincte sunt teste, nu adopție independentă.
SSO, multi-tenancy, Kubernetes, Windows desktop automation și un broker de comenzi
arbitrare pe host nu intră în acest RC.

## 2. Reconcilierea roadmap-ului și a versiunii

Există deja un RC intern ca versiune de package; nu îl redenumim retroactiv. În RC-00
alegem următorul identificator neutilizat, de exemplu `1.0.0-rc.1` dacă nu a fost publicat.
Verificarea tag-urilor și artefactelor precede alegerea; exemplul nu este o rezervare.

Separăm patru stări: DEVELOPMENT, RC_QUALIFIED, PUBLIC_RC_AUTHORIZED și STABLE_RELEASE.
Un scor sau un test PASS poate califica artefactul, dar nu autorizează push, tag, upload,
schimbarea licenței, publicarea sau apeluri LLM cu cost nelimitat.

Guard-ul public actual acceptă versiuni stabile `vX.Y.Z`. RC-06 trebuie să definească
o cale explicită de prerelease, cu aceleași garanții de integritate și cu GO separat,
fără a permite accidental oricărui tag `v*` să fie publicat drept release stabil.

Planul P6 cere macOS înainte de distribuție publică. Propunerea pentru primul RC este
Windows + Linux, cu macOS experimental. Aceasta necesită o decizie explicită și o
actualizare coerentă a politicii în RC-00; fără ea, obligația macOS existentă rămâne.
Nu eliminăm gate-uri prin simpla schimbare a etichetei produsului.

## 3. Acoperirea constatărilor auditului

| Constatare | Corecție planificată | Teste de acceptare din Planul 2 |
|---|---|---|
| Prompt pierdut fără stdin deschis; executabil Windows transmis containerului | RC-01 | T01–T03 |
| Mount-uri și probe filesystem insuficiente | RC-02 | T04–T06 |
| Anulare fără dovadă de oprire a containerului | RC-02 | T07–T09 |
| Proxy validat prin metadate, nu prin trafic real | RC-03 | T10–T12 |
| Procesele agentului împart rețeaua și pot vedea credențialele sale | RC-03, profil și limite explicite | T12–T14 |
| MCP și preflight pot executa validarea pe host | RC-04 | T15–T17 |
| Instalarea nu provisionază întreg mediul | RC-05 | T18–T21 |
| SBOM, GO, manifest și dovezi release incomplete | RC-06 | T27–T31 |
| README, versiuni și stări nealiniate | RC-00, RC-07 | T30–T33 |
| Flux real complet insuficient probat | RC-08 | T22–T26, T34–T36 |

## 4. Arhitectura țintă

```text
VS Code / agent principal de încredere
                |
       Infoapex CLI / orchestrator
                |
                +-- context și memorie limitate la proiect
                +-- agent container: workspace temporar + ieșire aprobată
                +-- execution container: build/test, fără credențiale LLM
                +-- servicii de test: rețea și date temporare per run
                +-- verificare rezultate + aplicare controlată + evidence
```

Orchestratorul nu rulează scripturi ale repository-ului pe host. Copia task-ului este
separată de repository-ul original, de politicile de încredere și de evidence. Un Git
worktree nu este o limită OS, iar fișierul său `.git` nu poate indica necontrolat către
un director Windows inaccesibil din Linux. Alegem export/snapshot sau metadate Git
izolate, nu montarea întregului `.git` al utilizatorului cu drept de scriere.

Containerele nu primesc socket Docker, mount-uri de home, dispozitive, host network,
host PID namespace sau `--privileged`. Folosim UID/GID non-root, root filesystem read-only,
capabilities eliminate, no-new-privileges și limite obligatorii. Profilurile kernel
suportate sunt declarate și verificate, nu pretinse identice pe orice platformă.

## 5. Pachete de lucru secvențiale

Estimări: zile de lucru efectiv pentru un maintainer familiar cu proiectul, incluzând
teste locale și review; nu zile calendaristice și nu promisiuni de livrare.

| ID | Dependențe | Livrabil | Responsabilitate principală | Efort |
|---|---|---|---|---:|
| RC-00 | — | Profil, threat model și contract RC înghețate | root / maintainer | 2–3 zile |
| RC-01 | RC-00 | Transport provider și portabilitate funcționale | worker / adapters | 3–5 zile |
| RC-02 | RC-01 | Workspace, resurse și cleanup verificabile | worker / execution | 4–6 zile |
| RC-03 | RC-02 | Rețea, proxy și secrete cu limite explicite | worker / infrastructură | 5–8 zile |
| RC-04 | RC-03 | Validări și MCP fără execuție neizolată | control + worker | 3–5 zile |
| RC-05 | RC-04 | Provisionare, instalare și recovery reproductibile | installer / lifecycle | 3–5 zile |
| RC-06 | RC-05 | Release, SBOM și integritate evidence | scripts / CI | 3–5 zile |
| RC-07 | RC-06 | README, diagnostic și parcurs utilizator | root / documentație | 2–3 zile |
| RC-08 | RC-07 | Calificare pe artefactul candidat | benchmark / control / maintainer | 4–6 zile |

### RC-00 — Contract de produs și baseline

- Inventariem suportul efectiv: host, arhitectură CPU, Docker, Node/.NET, provider CLI,
  model, metodă de autentificare, toolchain. Înghețăm versiunile exacte la execuție,
  folosind versiuni încă suportate atunci, nu cele memorate în plan.
- Propunere inițială: Windows cu Docker Desktop Linux containers și Linux cu Docker
  Engine, x86_64; `generic` și `dotnet-nextjs`. Mai întâi un provider; al doilea este
  declarat suportat numai după aceeași calificare, fără fallback automat.
- Menținem o singură listă de cerințe de release și derivăm sumarul documentar din ea.
  Nu rescriem evidențele istorice și nu transformăm automat PENDING în PASS.
- Stabilim profilul de date permise către LLM, autentificarea, bugetul live și canalul
  de distribuție. Licența proprietară rămâne neschimbată fără decizia maintainerului.
- Înregistrăm baseline-ul pe noua grilă de scor; nota anterioară de 6,5 era o opinie
  de audit, nu un rezultat calculat cu această grilă.

Ieșire: decizii consemnate; limite și gate-uri fără contradicții; matricea obligatorie
din Planul 2 aprobată înaintea rulărilor, nu redusă după un eșec.

### RC-01 — Transport și adaptoare

- Păstrăm stdin deschis fără pseudo-TTY pentru prompt și flux JSON; testăm Unicode,
  input gol, prompt mare în limita contractului, EOF, stdout/stderr și exit code.
- Separăm descoperirea executabilelor host de numele/căile din imagine. Nu transmitem
  automat `.exe`, `.cmd`, profiluri home sau config host în container.
- Definim traducerea căilor, working directory, HOME/config/cache temporare și
  rezultatele providerului. Refuzăm căi exterioare nemapate, nu le ghicim.
- Probe de versiune distincte de autentificare și de task real. Lipsa autentificării
  produce un cod explicabil, nu un provider alternativ.

Ieșire: T01–T03 PASS pe toate hosturile obligatorii, fără apel LLM pentru testele de transport.

### RC-02 — Workspace și ciclu de viață

- Politici și evidence în afara mount-ului writable al agentului. Exportul rezultatului
  verifică fișierele permise, link-uri, fișiere speciale și HEAD-ul original.
- Validăm sursele și destinațiile mount-urilor prin căi canonice, inclusiv junctions,
  symlink-uri și schimbări între verificare și utilizare. Fără mount-uri arbitrare.
- Înregistrăm container ID și identitate run/task; anulăm prin API/CLI pe acel ID,
  verificăm ieșirea și facem cleanup idempotent doar pentru resursele deținute.
- Adăugăm recovery după crash, lease expirat și restart Docker; dacă daemonul este
  indisponibil nu declarăm cleanup reușit. Reconciliem la revenire înainte de reluare.
- Limite de CPU, memorie, procese, timp, output și scratch storage; watchdog-ul nu
  poate suprascrie limita mai strictă a profilului.

Ieșire: T04–T09 PASS; nicio modificare în repository-ul original înainte de aplicare,
nicio resursă străină eliminată, niciun container de task rămas după cleanup reușit.

### RC-03 — Rețea și secrete

- Livrăm configurație reproductibilă pentru rețea internă și proxy cu imagine pinned;
  verificăm identitatea imaginii corect, diferențiind config digest de manifest digest.
- Hash-uim configurația efectiv încărcată. Testăm destinații permise și interzise;
  etichetele Docker nu sunt atestări independente ale comportamentului.
- Verificăm proxy URL, membri de rețea, gateway/host și căi IPv4/IPv6/DNS relevante.
  Blocăm accesul la metadata endpoints și la servicii corporate neautorizate.
- Separăm fetch-ul de dependențe, execuția build/test și serviciile de test. Nici
  scripturile de instalare npm/NuGet nu se execută pe host sau cu token de registry larg.
- Secrete scoped, revocabile și preferabil scurte; fără secrete în imagini, mount-uri
  de home, prompturi, argumente, loguri, evidence sau arhive release.

Decizie explicită pentru RC: profil `restricted-agent-egress` în care providerul și
subprocesele sale pot împărți ieșirea allowlisted; validările independente nu au acele
drepturi. Nu îl numim `provider-only` și nu promitem că propriile tool-uri ale providerului
nu pot citi credențiala din mediul său. Metoda de autentificare și riscul rezidual sunt
aprobate în RC-00. Un proxy de destinații nu împiedică exfiltrarea către o destinație permisă.

Dacă organizația cere secrete inaccesibile oricărui tool sau rețea strict provider-only,
este obligatoriu un profil separat: autentificare/broker extern compatibil cu providerul,
tool execution separat și dezactivarea căilor de execuție care îl ocolesc. Acest profil
nu se declară suportat până la propriile teste; efortul său nu este inclus în estimarea RC.

Ieșire: T10–T14 PASS pentru profilul declarat; raportul doctor distinge capabilități
testate, declarate, neacceptate și lipsa dovezilor.

### RC-04 — Închiderea căilor de execuție pe host

- Inventariem toate punctele de spawn din root, worker, review, docs și control:
  comenzi repository, Git hooks/submodule operations, build, lint, tests și MCP.
- `run_validation`, guard și validările preflight folosesc runnerul autorizat;
  simpla includere a unui binar pe allowlist nu face scripturile sale de încredere.
- Separăm diagnostic read-only de validarea care execută cod. MCP de context oferă
  operații scoped; cererile de execuție trec prin contractul de policy și runner.
- Nicio degradare automată la PowerShell/Bash pe host dacă Docker este indisponibil.
- Autoritatea asupra politicii nu vine dintr-un fișier modificabil de worker. Revalidăm
  politica înainte de aplicarea rezultatului și de operații cu efecte externe.

Ieșire: T15–T17 PASS, inclusiv task malițios care încearcă să forțeze validarea pe host.

### RC-05 — Instalare și provisionare

- Preview al resurselor, mount-urilor, rețelelor și permisiunilor înainte de provisionare;
  operație distinctă, explicită, idempotentă. Nu acordăm permisiuni recursive generale.
- Imagini separate/minimale de provider și toolchain, pinned și reconstruibile.
  Proxy, certificate corporate și cache configurabile, fără secrete baked-in.
- Doctor raportează separat config, Docker, filesystem, proxy, autentificare, task;
  probele live care pot costa sunt opt-in.
- Testăm ZIP și pachet npm instalate, nu doar checkout-ul; managed-file ownership,
  backup verificat, upgrade, rollback și uninstall păstrează modificările utilizatorului.
- Tutorial pentru Linux tooling și limitările Windows-only; fără broker de comenzi
  Windows arbitrare. Modurile fără internet/provider au rezultate explicite.

Ieșire: T18–T21 PASS; primul task nu necesită editări manuale nedocumentate de config.

### RC-06 — Supply chain, release și dovezi

- SBOM real: dependențe npm/NuGet directe și tranzitive, purl, versiuni, relații,
  licențe și hash-uri unde sunt disponibile; separat inventarul imaginilor OS/toolchain.
- Scanări de vulnerabilități și secrete, analiză de licențe, politici pentru actualizări;
  niciun risc critic/ridicat aplicabil nerezolvat în profilul distribuit.
- GO citit din blob-ul Git al unui commit de aprobare identificat și autorizat, separat
  de commit-ul candidatului. Decizia leagă explicit candidateCommit, versiunea și
  hash-urile artefactelor; un fișier local necomis nu este suficient. Policy manifest
  conține setul complet de fișiere obligatorii, verificat față de commit-ul candidatului.
- Evidence index cu commit, hashes de artefact/config/imagine, mediu și comenzi;
  intrări vechi rămân istorice, nu devin automat dovezi pentru noul candidat.
- CI provisionază explicit mediul hermetic înaintea gate-ului Docker. Separăm probele
  fără credențiale de dovezile live aprobate, pentru a nu expune secrete pe PR-uri.
- Workflow pinning, privilegii minime pe job, protecție de tag și aprobare de publicare.
  Prerelease și stable au validare strictă distinctă. Verificăm semnături/atestări,
  nu deducem validitatea lor din existența unui pas YAML.
- Evităm dependența circulară GO–commit–artefact: întâi înghețăm commit-ul candidatului,
  construim și calificăm artefactele, apoi înregistrăm GO într-un commit/ref de aprobare
  separat. Workflow-ul verifică autoritatea acelui ref și publică artefactele deja
  calificate, nu reconstruiește o versiune diferită din commit-ul de aprobare.
  Schimbarea intrărilor relevante impune revalidare și o decizie nouă. Aceasta este o
  modificare planificată a contractului guard-ului actual, nu o facilitate existentă.

Ieșire: T27–T31 PASS, inclusiv variante alterate intenționat care trebuie respinse.

### RC-07 — Documentație și operabilitate

- README reflectă toate modulele, limitele automatizării root, modurile MCP și permisiunile.
  Nu promite reduceri universale de cost sau izolare nedemonstrată.
- Quickstart copy/paste validat din artefact, troubleshooting pe coduri de eroare,
  matrice de suport și instrucțiuni de recovery/uninstall.
- Status distinct pentru starea instalării și starea task-ului; sumar run/task/criteriu/
  diff/validare/evidence, cu output bounded și redactat.
- Bugete de invocări, timp și consum explicate înainte de execuție; provider/model/fallback
  rămân politici explicite. Fără logarea conversațiilor brute ca mecanism de diagnostic.

Ieșire: T24–T26, T32–T33 PASS; documentele de release nu se contrazic între ele.

### RC-08 — Calificare și închidere

- Executăm Planul 2 pe artefactul înghețat, nu declarăm DONE doar pentru că testele unitare trec.
- Reparăm defectele, emitem un candidat nou când intrările se schimbă și reluăm matricea afectată.
- Review în sesiune separată, realizabil de același maintainer; este re-review, nu audit independent.
- Livrăm raport de scor, gate-uri, limitări, consum și decizie RC_QUALIFIED/NO_GO.
- Publicarea rămâne o cerere separată cu GO explicit; nu există publicare în acest plan de execuție.

Ieșire: T34–T36 PASS și toate condițiile obligatorii ale Planului 2 îndeplinite.

## 6. Mod de lucru cu modulele proprii

Fiecare pachet se descompune în task-uri mici cu scope, criterii și teste înainte de cod.
`ai-code-control` asigură memory-health, brief, simboluri/impact pentru cod existent,
manifest scoped, verificarea schimbărilor și evidence. Indexurile sunt cache, nu autoritate.
`ai-code-worker` este preferat pentru implementare numai după ce runnerul folosit este
calificat pentru acel task. Înainte de RC-01/RC-02, nu folosim un runner defect drept
dovadă a propriei corectitudini; testele hermetice și editarea locală explicit autorizată
rămân disponibile. Nu invocăm provideri fără politica și bugetul live aprobate.

Review-ul verifică diff-ul și evidence, nu doar rezumatul workerului. Nu marcăm un task
DONE cu teste obligatorii SKIPPED/INCONCLUSIVE. Documentele nu actualizează singure
statusurile machine-readable și nu pretind că implementarea a început.

## 7. Estimare și puncte de oprire

Total de bază: 29–46 zile de lucru, inclusiv testele pe pachet și calificarea finală.
Rezervă orientativă 25%: aproximativ 36–58 zile, adică 7–12 săptămâni la timp complet.
Nu se adaugă din nou testele Planului 2 peste această estimare. Hardware indisponibil,
integrarea SSO a providerilor, profilul strict-corporate sau o matrice mai largă pot crește efortul.

Oprire și replanificare dacă: un provider nu poate rula cu permisiunile acceptate;
autentificarea cere expunerea neacceptată a secretelor; rețeaua nu poate fi impusă;
toolchain-ul necesită Windows-only; publicarea cere o schimbare de licență/autoritate.
Nu se rezolvă aceste blocaje prin creșterea tăcută a permisiunilor.

## 8. Referințe normative externe

Opțiunile stdin, container ID, user și limite se verifică față de
[Docker run](https://docs.docker.com/reference/cli/docker/container/run/).
Accesul la daemon rămâne privilegiat; recomandarea de a nu-l expune workerului urmează
[Docker Engine security](https://docs.docker.com/engine/security/).
Identificatorii RC sunt prerelease-uri, distincte de versiunea stabilă conform
[Semantic Versioning](https://semver.org/).
Consultate la 2026-09-13; versiunile suportate se reverifică la înghețarea candidatului.
