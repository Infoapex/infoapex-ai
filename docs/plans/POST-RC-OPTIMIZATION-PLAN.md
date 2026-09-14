# Plan 3 — Reducerea costului, complexității și efortului de mentenanță

> Decizie 2026-09-14: plan aprobat, păstrat în [TODO](../../todo.md) ca etapă ulterioară.
> Nu blochează RC-ul intern trusted-host fără Docker și nu marchează optimizările DONE.

Data: 2026-09-13

Status: APROBAT ca backlog amânat; economiile nu sunt încă demonstrate

Baseline obligatoriu: artefact calificat prin [Planul 2](RC-VALIDATION-AND-SCORING-PLAN.md)

Fundație: [Planul 1](RC-HARDENING-IMPLEMENTATION-PLAN.md)

## 1. Obiectiv

Păstrăm corectitudinea, izolarea și trasabilitatea, reducând costurile care pot face
proiectul disproporționat pentru task-uri mici sau dificil de întreținut solo.
Optimizăm măsurat, nu prin eliminarea validărilor ori reducerea tăcută a modelului.

Instrumentarea minimă de cost și durată aparține RC-ului. Optimizările de mai jos nu
sunt condiții pentru primul RC peste 8/10; rezultatele lor vor produce o versiune
ulterioară sau un RC ulterior, cu regresia și calificarea aferente.

## 2. Dezavantaje și răspunsul planificat

| Dezavantaj | Intervenție | Ce nu sacrificăm |
|---|---|---|
| Multe configurații, pași și stări | OPT-01: profiluri și workflow ghidat | aprobări, policy și audit trail |
| Context mare și cost pentru task-uri mici | OPT-02: context incremental și execuție proporțională | criterii, date relevante, controale obligatorii |
| Porniri Docker și instalări repetate | OPT-03: imagini/cache și validare incrementală | separarea proiectelor și revalidarea release |
| Dependență de CLI-uri și schimbări de versiune | OPT-04: contracte/adaptoare și update canary | pinning și refuzul fallback-ului neaprobat |
| Documente/stări duplicate și multă mentenanță | OPT-05: status derivat și simplificare internă | surse canonice și istoric nemodificat |
| Dificultatea demonstrării valorii | OPT-00, OPT-06: baseline și experiment controlat | raportarea eșecurilor și incertitudinii |

## 3. Baseline și protocol de măsurare

OPT-00 precede toate schimbările. Lot propus: 12 task-uri proprii, patru mici, patru
medii și patru multi-componentă, fiecare cu criterii și evaluator fix. Într-un experiment
live, 3 repetări paired per task și variantă => 36 perechi / 72 execuții pentru comparația
unei optimizări cu baseline-ul. Nu rulăm automat întregul lot pentru fiecare patch.

Mai întâi filtrăm ipotezele prin replay/fixtures deterministe. Bugetul live se aprobă
separat; dacă nu susține lotul, experimentul rămâne exploratoriu/INCONCLUSIVE pentru
afirmații generale, nu schimbăm retrospectiv pragurile de acceptare.

Înregistrăm:

- first-pass și eventual acceptance, numărul de repair/retry, criterii încălcate;
- input/output/cached tokens unde providerul le raportează; cost API real separat de
  quota abonamentului, estimări și consum indisponibil; nu le convertim arbitrar între ele;
- durată end-to-end, durată locală fără LLM, pornire container, indexare, build și review;
- intervenții umane, pași de configurare, erori de setup, disk/memory și volume de evidence;
- profil/model/versiune, workload, hardware, cache cold/warm, toate eșecurile și excluderile.

Metricile se raportează per clasă de task și mediană/intervale. p95 pentru măsurători
locale numai pe >=100 observații comparabile; cu eșantioane mici raportăm distribuția
și maximul fără a pretinde precizie de tail latency.

Același provider/model/reasoning, snapshot și criterii per pereche; ordine alternată
sau randomizată și warm/cold separate. Nu schimbăm simultan contextul, modelul și
politica de review dacă vrem să atribuim efectul uneia dintre ele.

## 4. Pachete de optimizare

| ID | Dependență | Efort estimat | Livrabil |
|---|---|---:|---|
| OPT-00 | RC calificat | 2–3 zile | metrici, lot și baseline înghețate |
| OPT-01 | OPT-00 | 2–4 zile | onboarding și workflow ghidat mai simple |
| OPT-02 | OPT-01 | 3–5 zile | context selectiv și reducerea muncii LLM redundante |
| OPT-03 | OPT-02 | 3–5 zile | cache sigur și accelerare runtime/build |
| OPT-04 | OPT-03 | 2–4 zile | contracte provider și actualizare controlată |
| OPT-05 | OPT-04 | 2–4 zile | eliminarea duplicărilor de configurare/status |
| OPT-06 | OPT-05 | 2–3 zile | experiment final, re-review și decizie de păstrare |

Total orientativ: 16–28 zile de lucru, plus rezervă 25% => 20–35 zile. Ordinea este
secvențială pentru maintainer solo. Nu adăugăm această durată la blocajele primului RC.
Refactorizări mari de adaptor sau schimbarea tehnologiei de distribuție se estimează separat.

### OPT-00 — Baseline economic și operațional

- Legăm metricile de run/task/context digest și outcome, fără transcripturi brute.
- Stabilim ce parte din timp/cost aparține LLM, orchestrării, Docker, indexării și testelor.
- Înghețăm hardware-ul de referință, lotul, pragurile și bugetul live înainte de comparație.
- Păstrăm un raport pentru task-uri mici: nu presupunem că full orchestration este
  întotdeauna mai ieftină decât utilizarea directă a agentului.

Acceptare: fiecare rezultat are unități și proveniență; nicio comparație de cost între
unități incompatibile; baseline complet sau explicit INCONCLUSIVE.

### OPT-01 — Mai puțini pași și configurații

- Un profil suportat cu valori sigure, overlay explicit pentru proiect și explicația
  originii fiecărei valori. Nu introducem încă un fișier pentru aceleași reguli.
- Workflow ghidat peste comenzile existente: plan, inspect/accept, run, review, docs,
  status/resume. Comenzile noi, dacă sunt justificate, sunt proiectate și testate atunci;
  nu pretindem că un `task submit` complet autonom există deja.
- O prezentare unică a următorului pas și a blocajului; doctor nu confundă configurarea
  validă, containerul funcțional și autentificarea/providerul live.
- CLI/MCP folosesc același contract, cu pause pentru aprobările materiale; fără publicare
  sau escaladare implicită de drepturi.

Ținte propuse: reducere >=30% a acțiunilor manuale față de baseline; nicio editare JSON
manuală în quickstart-ul standard; același control al permisiunilor și zero regresii T18–T23/T32.
Verificarea făcută de maintainer după checklist nu este prezentată ca studiu UX independent.

### OPT-02 — Context proporțional și mai puține invocări redundante

- Refolosim context-package și invalidarea incrementală existente înainte să adăugăm
  alte mecanisme. Cache key include proiect/tenant, commit și dirty digest, scope,
  policy, index version, surse, provider/model și contract de context.
- Brief bounded: criterii, simboluri și vecinătate relevantă înainte de documente întregi.
  Sursele stale lipsă produc diagnostic; nu eliminăm context important ca să micșorăm metrica.
- Planul acceptat și rezultatele deterministe se reutilizează numai dacă intrările relevante
  sunt identice; nu reutilizăm automat verdictul LLM pentru cod diferit.
- Profil fast pentru task-uri mici, numai dacă reguli deterministe îl permit; păstrează
  scope, izolare, teste și evidence obligatorii. Riscul ridicat păstrează review-ul complet.
- Orice schimbare de provider/model rămâne decizie separată, niciodată o optimizare ascunsă.

Ținte propuse: >=20% reducere mediană a contextului trimis și >=15% reducere a consumului
end-to-end măsurabil pe task-uri mici/medii; toate invocările de plan/review/repair incluse.
Calitatea și gate-urile de securitate nu se reduc; nu promitem economii pe task-uri mari.

### OPT-03 — Runtime și cache fără contaminare

- Imagini toolchain pregătite, layere reutilizabile, fetch de dependențe separat de execuție.
  Start cu containere noi per task; nu păstrăm procese/credite secrete pentru a economisi boot.
- Cache separat pe proiect și pe lockfile/runtime/policy; read-only unde este posibil.
  Registry tokens rămân în fluxul de fetch autorizat, nu în cache sau scripturi repository.
- Indexare incrementală și selecție de teste pe impact demonstrat; regresia completă
  rămâne obligatorie la release și când analiza este incompletă.
- Concurență doar între operații independente cu limite CPU/RAM; single-writer lease
  și aplicarea rezultatelor nu sunt eliminate pentru throughput.
- Optimizăm întâi timpul local dominant; nu introducem pooling complex dacă beneficiul
  este mic față de latența providerului.

Ținte propuse: >=30% reducere a medianei overhead-ului local warm pe workloadul definit;
cache cold raportat separat; creștere maxima de spațiu cache aprobată în OPT-00; zero
leak între proiecte și zero regresii de invalidare/cleanup.

### OPT-04 — Stabilitate față de schimbările providerilor

- Consolidăm contractele comune doar unde comportamentul coincide; păstrăm diferențele
  de auth, output și watchdog în adaptoare explicite, nu într-un adaptor generic fragil.
- Suită de contract pentru versiunile pinned și un canary de actualizare; upgrade-ul
  este propunere cu evidence și rollback, nu actualizare automată în timpul task-ului.
- Centralizăm versiunea acceptată și erorile de incompatibilitate. Dependențele root/module
  primesc ownership și verificare de provenance pentru patch-urile vendored.
- Un adaptor SDK este opțional numai dacă măsurătorile justifică migrarea; nu se adaugă
  în paralel cu CLI-ul fără un plan de suport și de autentificare.

Acceptare: toate contractele suportate trec; o versiune incompatibilă e respinsă înainte
de execuție; actualizare și rollback verificate în fixture, fără schimbare de provider implicită.

### OPT-05 — Reducerea muncii de mentenanță și a documentației contradictorii

- Un registru machine-readable pentru capabilități, scheme, versiuni și gate-uri;
  README/status sunt vederi generate sau verificate față de registru, nu surse concurente.
- Documentele de arhitectură explică deciziile; rapoartele de task consemnează rezultate.
  Evităm repetarea acelorași procente de progres în mai multe fișiere.
- Scoatem câte o duplicare de policy/config per schimbare mică și testată; nu reconstruim
  toate modulele într-un monolit pentru a reduce numărul de directoare.
- Diagnostic bazat pe coduri, remediere și evidence minimal; retention/cache quotas cu
  dry-run și cleanup numai pe resurse deținute.
- Dashboard CI pentru contract drift, dependency updates și teste flaky; ownership solo
  clar și runbook suficient ca maintainerul să reia proiectul după o pauză.

Ținte propuse: zero valori contradictorii pentru versiuni/gate-uri; reducere >=30% a
locurilor editate pentru schimbarea unei politici comune; nicio degradare a trasabilității.

### OPT-06 — Decizie bazată pe rezultate

- Comparăm baseline și versiunea optimizată pe lotul înghețat; includem încercările eșuate,
  costul repair-ului și intervențiile maintainerului.
- Păstrăm numai schimbările cu beneficiu măsurat și cost de mentenanță acceptabil.
  O optimizare fără semnal suficient este amânată sau retrasă, nu declarată succes.
- Reexecutăm gate-urile afectate din Planul 2 și scorecard-ul; optimizarea nu poate scădea
  proiectul sub pragul RC sau sub minimele securitate/fiabilitate.
- Publicăm rezultatele numai dacă autorizate, cu limitele lotului și fără concluzii universale.

## 5. Reguli de acceptare și oprire

O schimbare este eligibilă pentru păstrare dacă:

1. toate gate-urile obligatorii de securitate, integritate și funcționare rămân PASS;
2. pe lotul paired nu apare nicio regresie neexplicată a criteriilor deterministe sau
   reducere a numărului de task-uri acceptate; orice diferență LLM este investigată;
3. obiectivul de cost/timp/complexitate preregistrat este atins, cu suficiente observații;
4. inputuri, cache misses, eșecuri și cost total sunt raportate, nu doar best-case warm;
5. rollback-ul este simplu și păstrează datele și evidence.

Pe un lot mic, lipsa regresiei observate nu dovedește non-inferioritate generală. Pentru
o afirmație statistică mai puternică se proiectează ulterior un experiment cu putere
adecvată. Nu impunem un studiu mare ca blocaj arbitrar pentru o optimizare locală modestă.

Oprire imediată pentru leak, reducerea drepturilor impuse, amestec de context între
proiecte, fallback ascuns, cost necontrolat ori checkpoint reutilizat cu intrări diferite.
Restaurăm versiunea calificată prin mecanismele de rollback testate; nu ștergem dovezile.

## 6. Rezultatul dorit

Un produs cu același nivel de control, dar mai puțini pași manuali, mai puțin context
redundant, porniri/build-uri mai rapide și mai puține locuri de întreținut pentru fiecare
schimbare. Reducerile procentuale de mai sus sunt ținte de experiment, nu promisiuni
actuale și nu justificări pentru a slăbi granița de securitate.
