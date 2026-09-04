# Plan de reluare Infoapex AI — P0–P5

Status: **accepted**  
Data: **2026-08-30**  
Repository canonic: `Infoapex/infoapex-ai`  
Baseline pre-ICM: `92f79b6535da79a0a81695899f98b59ca3869bd8`  
Branch ICM + Graph curent: `feat/icm-graph-engineering` (`e39ef92`)  
Pilot consumator: proiectul client activ, etapa curentă, 10 taskuri secvențiale  
Politică: maximum un writer; baseline-ul live este complet, dar `GRAPH-06` rămâne
dezactivat până la propriul experiment A/B preregistrat și autorizat explicit.

## 1. Scop

Acest document fixează ordinea de reluare a implementării Infoapex AI după pilotul ICM + Graph.
Separă explicit:

- ce trebuie închis înaintea primului release privat;
- ce validează valoarea și costul real al produsului;
- ce reprezintă productizare ulterioară;
- ce model GPT-5.6 și ce nivel de reasoning sunt recomandate pentru fiecare etapă.

P0–P3 formează calea critică spre primul release privat. P4 este următorul increment de produs.
P4.5 introduce evaluatorul independent `ai-code-benchmark` înaintea continuării P5.
P5 este post-stabilizare și nu blochează release-ul `v0.1.0`, dar fiecare schimbare P5
ulterioară trebuie evaluată față de baseline-ul P4.5.

## 2. Principiul de selecție a modelelor

Conform documentației oficiale OpenAI pentru familia GPT-5.6:

- `gpt-5.6-sol` este modelul de capacitate maximă pentru muncă profesională complexă;
- `gpt-5.6-terra` echilibrează inteligența și costul;
- `gpt-5.6-luna` este optimizat pentru workload-uri de volum mare și cost redus;
- `medium` este punctul de pornire echilibrat;
- `high` sau `xhigh` se justifică atunci când produc un câștig măsurabil de calitate;
- `max` se rezervă celor mai dificile workload-uri quality-first.

Sursa: [OpenAI — GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model).

Aplicarea în Infoapex AI:

| Model | Rol recomandat în proiect |
|---|---|
| `Sol` | arhitectură cross-repo, contracte, securitate, recovery, analiză de drift, review final de release |
| `Terra` | implementare bine delimitată, teste, CI, packaging, CLI și remedieri cu criterii clare |
| `Luna` | transformări mecanice, fixtures, matrice repetitive, documentație derivată și agregare de evidence |

Reguli:

1. Un model mai mic nu este autoritatea finală pentru schimbări de contract, securitate sau release.
2. `Luna` nu decide singur dacă un failure este quota, sandbox, policy sau defect de implementare.
3. `xhigh` se folosește punctual, nu ca implicit pentru toate taskurile.
4. `max` nu este recomandat în P0–P4 înainte ca eval-urile proprii să arate un avantaj față de `xhigh`.
5. Pentru comparații economice se păstrează configurația modelului înghețată pe fiecare braț al experimentului.

## 3. Rezumat executiv

| Etapă | Obiectiv | Model principal | Efort principal | Modele auxiliare | Blochează release 0.1 |
|---|---|---|---|---|---|
| P0 | Integrare și publicare ICM + Graph în modulele canonice | Sol | high | Terra high; Luna medium | Da |
| P1 | Telemetrie usage completă și comparabilă | Sol | high | Terra high; Luna medium | Da pentru afirmații de eficiență |
| P2 | Gate-uri live și comparație controlată | Sol pentru baseline și verdict | high | Terra high ca braț comparativ; Luna doar fixtures | Da |
| P3 | Bundle ZIP, clean install și release privat | Terra | high | Luna medium; Sol high pentru review final | Da |
| P4 | CLI root unificat | Sol la design, Terra la implementare | high | Luna medium pentru help/docs/fixtures | Nu |
| P4.5 | `ai-code-benchmark`: comparație direct / orchestration / full ICM | Sol la metodologie, Terra la implementare | high | Luna medium pentru fixtures | Nu pentru v0.1.0; da înainte de continuarea P5 |
| P5 | SDK-uri și operare avansată | Selectiv, per subproiect | medium–xhigh | toate trei, în funcție de risc | Nu |

## 4. P0 — Consolidarea ICM + Graph în produsul generic

**Stare implementare: completată, validată și publicată pe ramurile `main` la
2026-08-30.**

Pinurile pregătite pentru publicare sunt:

| Modul | Commit standalone `main` |
|---|---|
| `ai-code-control` | `b9c120b4bfa604e0e13a457d39dbf308a687a9f1` |
| `ai-code-worker` | `add22c9d1fee18ce308472db6783be5c4afa9df0` |
| `ai-code-planner` | `1e5534ba53c54896eafbfa140d0f88616bf9f138` |

Rezultatul validării: control `116/116`, worker `380/380`, planner `35/35`,
bundle root `3/3`; review gate, docs gate, value gate intern și pilotul intern
ICM + Graph sunt `PASS`. Pilotul live cu usage rămâne în P2, iar `GRAPH-06`
rămâne dezactivat.

### Obiectiv

Eliminarea driftului dintre bundle-ul `infoapex-ai`, repository-urile standalone și versiunile
fixate în proiectul consumator. La final trebuie să existe o singură linie canonică și reproductibilă.

### Ordine

1. Audit read-only al diferențelor dintre `main` și `feat/icm-graph-engineering`.
2. Separarea schimbărilor pe ownership:
   - `ai-code-control`: context compiler, trace graph, query, drift și Obsidian projection;
   - `ai-code-worker`: context enforcement, inputuri semantice, invalidare și source maps;
   - `ai-code-planner`: contractele de criterii, gates și traceability;
   - `infoapex-ai`: integrare, scripts, gate comun și documentație.
3. Portarea și merge-ul schimbărilor în repository-urile standalone.
4. Rularea suitelor complete pe fiecare repository.
5. Actualizarea bundle-ului `infoapex-ai` numai din versiuni standalone validate.
6. Review cross-repo al schemelor și compatibilității backward.
7. Merge în `infoapex-ai/main`.
8. Decizie explicită pentru `ai-code-apex`: compatibility shim read-only sau arhivare.

### Recomandare de model

- **Arhitectură, split pe ownership și review de contract:** `Sol high`.
- **Portări delimitate și sincronizare mecanică:** `Terra high`.
- **Regenerare fixtures, indexuri și documentație repetitivă:** `Luna medium`.
- **Review final înainte de merge:** `Sol high`; `xhigh` numai dacă apar conflicte de schemă sau compatibilitate greu de demonstrat.

Modelul principal al etapei este **Sol high**, deoarece o eroare de ownership poate crea două
implementări divergente care par ambele canonice.

### Livrabile

- commituri standalone pentru control, worker și planner;
- bundle actualizat din surse validate;
- matrice `module → commit → schema version`;
- ADR privind statutul `ai-code-apex`;
- CI verde și worktree-uri curate.

### Gate de ieșire

- aceleași contracte ICM sunt validate în standalone și bundle;
- proiectul consumator poate fixa numai commituri existente pe remote;
- nu există cod ICM important prezent exclusiv în copia vendorizată;
- toate testele și gate-ul intern ICM + Graph trec.

## 5. P1 — Telemetrie usage completă

### Obiectiv

Închiderea `AI-CODE-USAGE-TELEMETRY-001`, astfel încât fiecare run să raporteze fără estimări
inventate: input uncached, cache read, cache write, output, cost disponibil și completitudinea
telemetriei.

### Ordine

1. Capturarea fixture-urilor sanitizate pentru formatele reale Codex și Claude.
2. Versionarea parserelor pe provider și formă de eveniment.
3. Normalizarea usage per invocare, task și run.
4. Introducerea câmpului explicit de completitudine: `complete`, `partial`, `unavailable`.
5. Detectarea dublării evenimentelor cumulative versus incrementale.
6. Teste pentru cache, resume, retry, fallback și continuări manuale.
7. Raport estimate-versus-actual numai când ambele părți sunt comparabile.
8. Eșec fail-closed pentru verdictul economic, nu pentru execuția funcțională.

### Recomandare de model

- **Semantica usage și designul contractului:** `Sol high`.
- **Implementarea parserelor și testelor:** `Terra high`.
- **Generarea matricei de fixtures sanitizate:** `Luna medium`, urmată de validare Terra/Sol.
- **Review pentru contabilizare dublă, cache și resume:** `Sol high`.

Modelul principal este **Sol high**. Telemetria greșită este mai periculoasă decât telemetria
lipsă, deoarece ar transforma o estimare într-o afirmație financiară falsă.

### Livrabile

- schemă usage versionată;
- parsere Codex și Claude cu fixtures reale sanitizate;
- agregare deterministă task/run;
- raport de completitudine;
- regresii pentru retry, resume și fallback.

### Gate de ieșire

- niciun câmp necunoscut nu devine `0`;
- evenimentele cumulative nu sunt însumate de două ori;
- un run complet produce totaluri reproductibile;
- un run parțial rămâne explicit `inconclusive`.

### Status 2026-08-30

P1 este implementat. Contractul normalizat `1.0`, parserele versionate Codex/Claude,
semantica explicită folosit versus rămas, agregarea cumulative/incrementală,
deduplicarea la resume și verdictul economic fail-closed sunt sincronizate din
`ai-code-worker` la commitul publicat din `modules/provenance.json`. Suita standalone
a trecut 388/388 teste; validarea bundle-ului este gate-ul final al acestei etape.

## 6. P2 — Gate-uri live și comparație controlată

### Obiectiv

Validarea comportamentului real al providerilor și a valorii Infoapex AI față de folosirea
directă a agentului, fără a confunda validarea funcțională cu eficiența economică.

### Ordine

1. Înghețarea datasetului, taskurilor, commitului, promptului, modelului și efortului.
2. Smoke task Codex cu telemetrie completă.
3. Smoke task Claude cu telemetrie completă.
4. Test controlat de quota/provider/sandbox și clasificarea fallback-ului.
5. Trei taskuri reale reprezentative în trei brațe:
   - agent direct;
   - Infoapex AI fără enforcement ICM;
   - Infoapex AI cu enforcement ICM.
6. Compararea first-pass success, retries, intervenții umane, context uncached, total tokens,
   latență și timp de explicație.
7. Extindere la 10 taskuri numai dacă pilotul de trei taskuri nu arată un regres major.

### Recomandare de model

- **Baseline comparabil cu pilotul Orders:** `Sol high`.
- **Braț cost-balanced ulterior:** `Terra high`, pe aceleași taskuri și aceleași criterii.
- **Luna:** numai pentru fixtures și procesarea deterministă a rapoartelor; nu pentru primul verdict de calitate.
- **Analiza și verdictul experimentului:** `Sol high`; `xhigh` doar pentru rezultate contradictorii sau findings de securitate.

Modelul principal este **Sol high**, deoarece continuitatea cu baseline-ul existent este mai
importantă decât economisirea de tokeni în prima măsurare. Terra devine al doilea braț, nu
înlocuitorul baseline-ului.

### Gate de ieșire

- semnalele live nu sunt clasificate pe baza unei presupuneri;
- toate brațele au configurații înghețate și evidence comparabil;
- verdictul separă calitatea, costul, latența și efortul uman;
- `GRAPH-06` rămâne oprit până la un baseline secvențial complet.

### Status P2-A — 2026-08-30

Preflight-ul bounded cu exact două invocări live este `PASS` funcțional. Codex
`gpt-5.6-sol/high` și Claude `sonnet` au finalizat taskurile secvențial; clasificarea
quota/sandbox versus failure determinist a trecut. Claude a produs usage complet,
iar Codex a necesitat fallback read-only la rollout pentru tokeni și nu a raportat
cost USD. Verdictul economic comun rămâne corect `inconclusive`. P2-B poate începe
ca experiment funcțional controlat, fără afirmații economice complete și fără
activarea `GRAPH-06`.

## 7. P3 — Primul release privat

### Obiectiv

Publicarea unui bundle privat `v0.1.0` care se instalează și se verifică într-un mediu curat,
fără dependență accidentală de directoarele locale de dezvoltare.

### Ordine

1. Construirea ZIP-ului din commituri fixate.
2. Extragere într-un director temporar curat.
3. `setup`, `build` și `test` fără cache de dezvoltare.
4. `init` și `status` în mod `independent`.
5. `init`, `handoff` și `status` în mod `integrated`.
6. Smoke planner → worker → review → docs → control.
7. Matrice Windows/Linux în CI.
8. Verificare licențe, provenance, checksum și release notes.
9. Tag și publicare privată.

### Recomandare de model

- **Implementare packaging/CI:** `Terra high`.
- **Matrice repetitive, checksums și documentație:** `Luna medium`.
- **Review final de securitate, supply chain și release:** `Sol high`.
- **`xhigh`:** numai dacă release review găsește neclarități în bootstrap, credențiale sau provenance.

Modelul principal este **Terra high**: munca este extinsă, dar bine delimitată și dominată de
automatizare și verificări reproductibile. Sol rămâne gate-ul final.

### Gate de ieșire

- ZIP-ul funcționează după extragere într-un proiect fără checkouturile sursă;
- instalarea nu citește secrete sau căi de pe mașina de build;
- toate modulele raportează versiunile fixate;
- CI Windows și Linux este verde;
- release notes enumeră limitele cunoscute și gate-urile încă deschise.

## 8. P4 — CLI root unificat

**Stare implementare: completată pe `main` la 2026-09-03.** CLI-ul root deleagă
`doctor`, `plan`, `run`, `resume`, `review` și `docs` către modulele standalone prin
subprocese și păstrează envelope-ul comun definit de ADR-0003.

### Obiectiv

Extinderea CLI-ului root de la `init | status | handoff` la o interfață coerentă care deleagă,
fără să dubleze logica modulelor:

```text
infoapex-ai doctor
infoapex-ai plan
infoapex-ai run
infoapex-ai status
infoapex-ai resume
infoapex-ai review
infoapex-ai docs
```

### Ordine

1. ADR pentru ownership-ul comenzilor și contractul de delegare.
2. Registry versionat de module/capabilități.
3. Rezolvare robustă a executabilelor și versiunilor.
4. Forwarding de argumente fără reinterpretarea contractelor modulelor.
5. Envelope JSON și exit codes comune.
6. Help, diagnostic și erori coerente.
7. Teste contract și E2E pentru fiecare comandă.
8. Compatibilitate cu folosirea standalone a fiecărui modul.

### Recomandare de model

- **ADR, command ownership și schema comună:** `Sol high`.
- **Implementarea comenzilor și forwarding:** `Terra high`.
- **Help, exemple, fixtures și snapshot tests:** `Luna medium`.
- **Review final de compatibilitate:** `Sol high`.

Modelul principal este **Sol high** pentru design, apoi **Terra high** pentru implementarea
repetitivă. Nu recomand implementarea întregii etape exclusiv cu Sol.

### Gate de ieșire

- root CLI nu importă source code din module;
- nicio comandă nu schimbă semantics față de CLI-ul standalone;
- JSON și exit codes sunt validate la fiecare boundary;
- absența unui modul produce un diagnostic clar, nu fallback ascuns.

## 9. P4.5 / BENCH — `ai-code-benchmark`

**Stare integrare 2026-09-04: baseline live complet și modul standalone publicat.** Modulul este
al șaselea modul al bundle-ului și este acoperit de setup/build/CI/release smoke,
inclusiv BENCH-D deterministic. Repository-ul standalone
`Infoapex/ai-code-benchmark` este publicat pe `main`, iar bundle-ul este pinned la
`899d14894444121f5f7141f6850eb62841b33152`. BENCH-D nu este un baseline live P5. Campania BENCH-09
R5, înghețată și autorizată separat, a închis 30/30 observații valide, zece perechi
și zero incidente critice; `P5-BASELINE.v2` poate fi folosit pentru evaluarea
candidaților. Raportul baseline este `INCONCLUSIVE` deoarece nu conține o ipoteză
P5. Primul candidat separat, OpenTelemetry redactat R2, a închis 20/20 observații
valide cu verdict intern direcțional `ACCEPT`; primul BENCH-P respins și canary-ul
P5 R1 oprit fail-closed rămân imuabile și separate.

### Obiectiv

Construirea unui evaluator independent, înainte de continuarea P5, care compară paired
aceleași taskuri în minimum trei brațe:

1. Codex/Claude folosit direct;
2. Infoapex AI orchestration-only, fără enforcement ICM;
3. Infoapex AI complet, cu ICM, Graph, gate-uri, repair și review.

Benchmark-ul separă calitatea, siguranța, efortul uman, latența și consumul; nu folosește
un scor compozit opac și nu acceptă self-report-ul agentului ca dovadă suficientă.

Planul canonic complet este
[`AI-CODE-BENCHMARK-IMPLEMENTATION-PLAN.md`](AI-CODE-BENCHMARK-IMPLEMENTATION-PLAN.md).

### Ordine

1. ADR, threat model și feasibility pentru cele trei brațe.
2. Repository standalone și contracte JSON versionate.
3. Dataset generic cu oracole independente.
4. Adaptoare direct Codex, direct Claude și Infoapex root.
5. Izolare, persistence, recovery și colectare de metrici.
6. Evaluator, statistică paired și raport JSON/Markdown.
7. Harness determinist fără provider.
8. Pilot live bounded pe 10 taskuri × 3 brațe.
9. Pin în bundle, comandă root `benchmark` și baseline P5.
10. Evaluarea OpenTelemetry deja implementat — completă, R2 `ACCEPT`.

### Gate de ieșire

- evaluatorul este independent de modulele evaluate;
- brațele pornesc din același commit și aceeași configurație comparabilă;
- datele necunoscute rămân `null` și produc verdict `INCONCLUSIVE` unde este cazul;
- testele deterministe, de recovery și security trec pe Windows/Linux;
- există minimum un pilot live complet, preregistrat și auditabil;
- fiecare subproiect P5 primește hypothesis, baseline, candidate și verdict măsurabil.

## 10. P5 — SDK-uri și operare avansată

### Obiectiv

Capabilități post-stabilizare. Fiecare subproiect cere justificare și pilot separat; P5 nu este
un singur milestone monolitic. OpenTelemetry redactat este implementat, pinned și
acceptat ca primul candidat intern: R2 a avut 20/20 observații valide, coverage
`0 → 1`, zero leakage, zero regresie paired de succes și overhead sub pragul
preregistrat. Verdictul nu se transferă altor candidați. Fiecare subproiect următor
necesită propria ipoteză, propriul experiment și propria autorizare.

### Subproiecte și modele

| Subproiect | Model | Efort | Motiv |
|---|---|---|---|
| Adaptoare Codex SDK / Claude Agent SDK | Sol | high | schimbă boundary-ul providerului și recovery semantics |
| OpenTelemetry fără conținut sensibil | Terra | high | implementare standardizată, dar cu cerințe stricte de redactare |
| Draft PR adapter cu autorizare | Sol | xhigh | acțiune externă, permisiuni și risc de scope expansion |
| Agent teams / parallel reviewers | Sol | xhigh | concurență, cost și independența reviewerilor; numai experiment controlat |
| Backend remote/CI izolat | Sol | xhigh | securitate, cleanup, lease și recovery distribuit |
| Policy signing, provenance și SBOM | Sol | high | supply-chain și autoritate criptografică |
| UI local pentru DAG/evidence | Terra | high | produs/UI peste contracte deja stabilizate |
| Provider registry suplimentar | Sol pentru contract, Terra pentru adaptor | high | semnale și sandbox diferite per provider |
| Generare fixtures/docs repetitive | Luna | medium | volum mare, risc redus și rezultate ușor verificabile |

### Ordine recomandată în P5

1. OpenTelemetry redactat — complet și acceptat intern prin R2.
2. UI local read-only pentru run/evidence.
3. Provider registry, fără provideri noi activați implicit.
4. SDK adapters prin pilot separat.
5. Draft PR adapter.
6. Backend-uri remote.
7. Policy signing/SBOM.
8. Agent teams și `GRAPH-06`, ultimul și numai după baseline.

### Gate de ieșire

Fiecare subproiect are ADR, threat model, contract versionat, teste negative și dovadă că nu
slăbește funcționarea standalone sau guardrail-urile existente.

## 11. Politică de execuție recomandată

1. P0, P1, P2 și P3 se execută strict în această ordine.
2. P4 începe numai după ce `v0.1.0` poate fi instalat curat.
3. P4.5 începe după P4 și devine gate obligatoriu înainte de continuarea P5.
4. OpenTelemetry, deja implementat, este păstrat după evaluarea R2 `ACCEPT`; evidențele R1/R2 nu se rescriu.
5. Restul P5 începe numai după baseline-ul P4.5, utilizare reală și feedback din minimum un proiect consumator.
6. Un singur writer per repository până la finalizarea P3.
7. Review-ul poate folosi alt model, dar rămâne secvențial; `GRAPH-06` nu se activează implicit.
8. Orice schimbare de model/effort într-un experiment produce un braț nou, nu modificarea
   retroactivă a baseline-ului.

## 12. Configurația recomandată dacă se dorește o singură alegere per etapă

```text
P0  gpt-5.6-sol    high
P1  gpt-5.6-sol    high
P2  gpt-5.6-sol    high   # baseline; Terra high este brațul comparativ
P3  gpt-5.6-terra  high   # Sol high pentru release review
P4  gpt-5.6-sol    high   # design; Terra high pentru implementare
P4.5 gpt-5.6-sol   high   # metodologie/verdict; Terra high pentru implementare
P5  per subproiect         # vezi matricea din secțiunea 10
```

Această distribuție păstrează Sol acolo unde o eroare de raționament poate crea drift de
contract sau risc de securitate, Terra acolo unde criteriile sunt deja înghețate și Luna acolo
unde rezultatul este mecanic și verificabil.
