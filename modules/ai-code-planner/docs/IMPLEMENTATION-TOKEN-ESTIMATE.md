# ai-code-planner — planul consolidat și estimarea de implementare

*Sursă plan: `Plan/Architect/_FINAL.md` (rev. 5, 2026-08-15) din repo-ul consumer project. Estimarea de tokeni/procente de mai jos e nouă, 2026-08-16, produsă prin analogie cu istoricul de consum real măsurat pe `ai-code-worker` (`docs/BENCHMARKS.md`) — vezi metodologia la finalul documentului.*

**Status curent:** doar Faza 0 a început (ADR-0001 acceptat, `finding.schema.json` livrat, schelet de repo). Fazele 1–5 și CP nu au nicio linie de cod. Tot ce urmează sub "estimare" e proiecție, nu măsurătoare.

---

## Current status

Planner v1 implementation is complete for context, deterministic planning, logical routing, worker export, Infoapex AI handoff, feedback ingestion, and replan. Consensus-panel planning, routing outcome analytics, and effort-per-task remain separate extensions.

## 1. Blocajul inițial — rezolvat

`docs/INFOAPEX-AI-VISION.md` conținea o contradicție: decizia 2 ("architect alege modelul per task") și decizia 4 ("worker nu se schimbă deloc") nu pot fi ambele adevărate — `manifest.schema.json` nu are câmp de engine/model pe task.

**Corecție acceptată:** rutarea per task e inexprimabilă azi, dar asta blochează *doar* Faza 3, nu tot proiectul. Planner scrie planuri, worker le execută, azi, fără nicio modificare — Fazele 0, 1 și 2A nu ating worker-ul deloc. ADR-0001 (`ai-code-planner`, status `accepted`) reformulează decizia 4: formatul de plan rămâne stabil, schema câștigă un bloc opțional `executionProfile` retrocompatibil.

Rutarea rămâne totuși **scopul produsului**, nu o optimizare secundară — azi se plătește același model pentru un README și pentru o migrație de bază de date.

## 2. Deciziile agreate

1. Architect (planner) e **read-only** — nu scrie cod, nu face commit.
2. Nu produce manifestul final — emite `Plan/<task>.md`; worker compilează, validează, îngheață.
3. **`executionProfile`** — profil logic în plan, rezolvat la compilare în snapshot înghețat (`engine`, `resolvedModel`, `fallbacks`, `reason`, `confidence`, `policyVersion`). Modelele concrete nu apar în planuri de business.
4. **Fallback:** planner propune → worker verifică → îngheață → execută tranzițiile. Interzis pentru `POLICY_FAILURE`, scope violation, test determinist eșuat — acelea cer `BLOCKED`/repair, nu fallback de model.
5. `reasoningEffort` **amânat** — niciun adaptor nu-l expune azi; se introduce doar dacă benchmark-urile arată valoare peste selecția modelului.
6. Complexitatea e **multidimensională + confidence**; XS–XL rămâne etichetă de prezentare. Review-ul se declanșează de risc/confidence, nu de etichetă.
7. **Linter determinist obligatoriu** înainte de execuție (fără LLM): DAG aciclic, dependențe existente, proveniență tipizată per input, scope-uri fără overlap necontrolat, `allowedPaths ∩ forbiddenPaths = ∅`, risc mare ⇒ `verify` nevid. *(7b: schema bogată internă ≠ exportul worker v1.0 — `compile` proiectează, iar pierderea de informație se validează și se raportează explicit.)*
8. `ai-code-control` **opțional în produs**, poate fi **obligatoriu prin politica repo-ului**. `none` nu e echivalent calitativ — reduce `confidence`.
9. **Fără import de cod** între tool-uri — doar CLI-JSON + scheme publice versionate.
10. **Pointeri în plan, conținut la execuție** — planner îngheață `requiredInputs`/`relevantSymbols`; worker rezolvă conținutul curent la runtime.
11. **Hermes = metodă** de decompoziție, nu format. `dependsOn` (ID-uri) e contractul public.
12. **OpenClaw** = doar model registry, doctor/probe, cooldown, fallback chain.
13. **Rutarea adaptivă nu e funcțională** până la `routing-outcome` — telemetria de azi (`UsageCheckpoint`) nu înregistrează model/repair-cycles/gate failures; poate estima cost, nu poate demonstra că o rută bate alta.
14. **Contractul worker fixat la `d23d5a0`** e minimul suportat; `origin/main` e candidat, nu upgrade automat.
15. **XL nu se trimite worker-ului** — planner propune milestones aprobate separat.

## 3. Fazele și porțile

| Fază | Conținut | Poartă |
|---|---|---|
| **0** | ADR-uri, matrice de compatibilitate worker, schema publică de plan + protocol CLI-JSON, contractul linterului, fixtures valide/invalide. **Fără runtime.** | Toate deciziile materiale acceptate sau marcate `proposed` |
| **1** | `propose`, `inspect`, `compile`, `explain-routing`. Decomposer `fanout=false`. Linter determinist. Export worker v1.0. **Fără rutare.** | 3 planuri consumer project reale trec linterul și rulează pe worker-ul existent |
| **2A** | Context **numai pentru planner**: protocol versionat, `brief`/`findSymbol`/`impact`, degradare explicită la `UNAVAILABLE`. **Nimic nu traversează spre worker.** | Planurile citează simboluri reale, coverage de impact verificată — worker nemodificat |
| **VG** | **Value gate** — 3 task-uri reprezentative, plan manual vs. plan generat | Dacă pică, se corectează decomposer-ul înainte de orice extindere |
| **CP** | `propose --panel` — consensus planning opt-in, inițial 2 familii de modele + review secvențial; L/XL sau risc mare → draft paralel orb | Panelul reduce omisiunile/corecțiile față de mono-agent suficient cât să justifice costul |
| **2B** | Handoff `relevantSymbols` + rezolvarea pointerilor la execuție. **Cere upgrade verificat de worker.** | Worker rezolvă simbolurile și le snapshot-uiește; contract tests trec pe versiunea nouă |
| **3** | `executionProfile`, dispatch Codex/Claude per task, routing snapshot, `doctor`, fallback finit. **Fără effort.** | Un run execută sigur ≥2 profiluri/motoare, reproductibil |
| **4** | Schema `routing-outcome`, comparații între rute, propuneri auditate de politică | O schimbare de routing poate fi justificată prin date |
| **5** | Effort per task *doar dacă* adaptoarele îl suportă și benchmark-ul arată valoare; fallback avansat; calibrare confidence | Fiecare extensie produce câștig măsurabil fără să slăbească gates |

**Fazele 0, 1 și 2A nu cer nicio modificare în `ai-code-worker`.** Prima schimbare de contract e în **2B**, nu în 3.

## 4. Value gate — criteriul de oprire

Rulează după Faza 2A, măsoară **exclusiv calitatea planificării**: coverage-ul criteriilor, ambiguități detectate înainte de execuție, scope violations prevenite, task-uri blocate corect, % executat fără revizie de manifest, intervenții umane, timp până la plan acceptat, costul planificării.

**Regula:** faza următoare pornește doar dacă planurile generate sunt cel puțin la fel de corecte ca baseline-ul manual **și** reduc costul, timpul sau intervențiile. Dacă pică, proiectul se oprește acolo — mai ieftin decât un planner care produce planuri plauzibile pe care nimeni nu le folosește.

## 5. Ce adaugă față de Claude/Codex folosite direct

| Folosire directă | Cu planner + worker + control |
|---|---|
| Un agent planifică, scrie și își evaluează propria muncă | Planificare, execuție și review separate |
| Planul derivă în conversație | Plan versionat, lint-uit, acceptat, înghețat |
| Scope-ul e o rugăminte în prompt | Scope-ul e constrângere verificată la commit |
| Un singur model pentru tot | Fiecare subtask primește profilul minim suficient |
| Paralelism improvizat | DAG + `concurrencyKeys` + worktree-uri = paralelism sigur |
| Costul e greu de anticipat | Estimări per task, buget global, outcome-uri versionate |

**Cel mai mare câștig practic:** eroarea se prinde înainte să coste — codul bun pentru problema greșită se vede într-un plan de 30 de linii, nu într-un diff de 400, înainte să se ardă tokeni de implementare.

## 6. Unde NU ajută

- **Task-uri mici** — overhead pur. Bypass (direct la Claude/Codex) vs. planificare light (`fanout=false`, un singur task cu scope/criterii) sunt fluxuri diferite.
- **Muncă exploratorie** — planul e prematur când nu știi încă ce vrei.
- **Nu face modelul mai deștept** — câștigul e de alocare, nu de capabilitate.
- **Introduce un mod de eșec nou** — un plan prost executat fidel e mai rău decât un agent bun care improvizează.
- **Crește latența** până la primul cod.

| Situație | Folosește |
|---|---|
| Typo, null check, 1 fișier reversibil | Claude/Codex direct (bypass) |
| Explorare, nu știi ce vrei | Claude direct, conversațional |
| Task mic dar auditabil | planner, mod light |
| 3+ fișiere sau 2+ subsisteme | planner |
| Contract API, migrație, securitate | planner + review independent obligatoriu |
| Greșeala e greu reversibilă | planner |

## 7. Consensus planning (CP) — pe scurt

Opt-in, proporțional cu complexitatea/riscul. Scopul nu e ca agenții să convearga spre aceeași formulare, ci să exploateze **moduri de eșec diferite** — unul găsește fapte din cod, altul contradicții sau criterii neverificabile. **Majoritatea nu stabilește adevărul tehnic**: doi agenți fără dovadă nu înving unul cu verificare reproductibilă.

Piese-cheie: registru structurat de constatări (`proposed`→`verified`/`refuted`/`accepted-as-assumption`/`needs-human`/`superseded`), un **verification broker** care NU execută shell generat de LLM (API-uri structurate, template-uri allowlisted, sandbox read-only, fără rețea/scrieri/secrete), terminare finită cu 4 rezultate (`CONSENSUS`, `CONSENSUS_WITH_DISSENT`, `HUMAN_DECISION_REQUIRED`, `INVALID_PLAN`), `planningProvenance` obligatoriu pe planul înghețat (cine, ce topologie, câte runde, ce cost), și un întrerupător de cost: planificarea nu poate depăși **~15% din costul estimat de execuție** (`maxPlanningCostRatio`).

Panelul se construiește **numai după** ce value gate-ul mono-agent trece (§9), și rămâne doar dacă îmbunătățirea față de mono-agent justifică repetat costul.

## 7bis. Decizii de produs ale userului (2026-08-15)

- **#11** Umbrela se numește `infoapex-ai`; numele retrase (`ai-code-runner`, `ai-code-architect`) rămân retrase.
- **#12** Dependența merge doar în sensul pipeline-ului (`planner → worker → control → review → docs`) și e mereu opțională cu degradare. Un tool consumă opțional, nu cere niciodată alt tool.
- **#13** Copierea de cod din worker în planner e permisă (nu importul) — dar schemele (identitate model, usage) rămân comune obligatoriu. Consecință: agent-runner-ul planner-ului folosește **adaptoare proprii**, nu un runtime comun extras (worker e fixat la `d23d5a0`; extragerea ar serializa tot proiectul după un refactor pilotat pe un singur consumator).
- **#14** Politica panelului: **oprit acum**. Mod principal = invocare manuală de user pentru PBI-uri mari (frontend+backend+DB), nu pentru modificări simple. Pornit implicit la L/XL și la orice atinge plăți/securitate/migrații, indiferent de mărime.

## 8. Ce rămâne de decis

1. ~~Reformularea Deciziei 4~~ — **ACCEPTATĂ** (ADR-0001).
2. Politica de versionare worker: țintă fixă `d23d5a0` sau upgrade după compatibility review?
3. Confirmarea amânării `reasoningEffort` (ambele analize recomandă da).
4. Setul de 3 task-uri consumer project pentru value gate.
5. Pragurile inițiale de `confidence` pentru review obligatoriu.
6. Ordinea de implementare în `infoapex-ai`: planner primul din cele trei (planner/review/docs)?

---

# Estimare de tokeni și procente pentru implementare

**Aceasta e o proiecție, nu o măsurătoare.** `ai-code-planner` nu are un jurnal de checkpoint-uri propriu (spre deosebire de `ai-code-worker`, care are `docs/BENCHMARKS.md` cu date reale din construcția Fazei 3 și a Part B). Estimările de mai jos sunt prin **analogie de scop** cu munca deja măsurată pe `ai-code-worker` — calibrare **~11.7k tokeni per punct procentual din fereastra de 5 ore** (interval real observat: 9.4–13.4k/pp, plan Claude Pro), plus raportul empiric real/estimat de **~0.45–0.8×** găsit acolo (mai jos pentru muncă ce reutilizează convenții deja stabilite, mai sus pentru subsisteme genuin noi).

## Tabel per fază

| Fază | Status azi | Scop (ce se construiește) | Tokeni estimați | %5h echiv. | %săpt echiv.* | Încredere |
|---|---|---|---:|---:|---:|---|
| **0** (rest) | ~55–65% făcut | 4 ADR-uri, 3 scheme (`plan`, `planning-provenance`, `execution-profile`), contract linter, fixtures valide/invalide | 130k–190k | 11–16pp | 1–2pp | Medie |
| **1** | Neînceput | `propose`/`inspect`/`compile`/`explain-routing`, decomposer `fanout=false`, linter runtime, export worker v1.0 | 350k–550k | 30–47pp | 3–5pp | Medie-scăzută — primul runtime real, fără pattern intern de urmat |
| **2A** | Neînceput | Provider de context versionat (doar pt. planner), `brief`/`findSymbol`/`impact`, degradare `UNAVAILABLE` | 80k–130k | 7–11pp | ~1pp | Medie-ridicată — mecanica poate copia direct din Part B al worker-ului (deja măsurat: 93.9k pentru echivalentul exact) |
| **VG** | Neînceput | 3 task-uri consumer project reale, plan manual vs. generat, nicio linie de runtime | 40k–70k | 3–6pp | <1pp | Scăzută — depinde de disponibilitatea task-urilor reale de comparat |
| **CP** | Neînceput, opt-in | Registru constatări, verification broker sandboxat, topologii panel, terminare, `planningProvenance` | 500k–750k | 43–64pp | 5–7pp | **Scăzută** — cel mai nou și mai mare subsistem din tot planul, fără analog direct la worker |
| **2B** | Neînceput, cere upgrade worker | Handoff `relevantSymbols`, rezolvare pointeri la execuție, cross-repo | 100k–180k | 9–15pp | 1–2pp | Medie |
| **3** | Neînceput | `executionProfile`, dispatch Codex/Claude per task, routing snapshot, `doctor`, fallback finit — **scopul produsului** | 400k–600k | 34–51pp | 4–5pp | Medie |
| **4** | Neînceput | Schema `routing-outcome`, comparații de rută, politică auditată | 150k–250k | 13–21pp | 1–2pp | Medie |
| **5** | Neînceput, condiționat | Effort per task *doar dacă* Faza 4 arată valoare; fallback avansat; calibrare confidence | 150k–300k | 13–26pp | 1–3pp | **Foarte scăzută** — scop deschis, poate fi mult mai mic sau chiar sărit |

*\%săpt e derivat, nu măsurat direct — folosește raportul empiric ~9:1 (%5h : %săpt) observat pe worker; tratează-l ca ordine de mărime, nu ca prognoză.*

## Totaluri

| Domeniu | Tokeni | %5h echiv. | %săpt echiv. |
|---|---:|---:|---:|
| **Cale minimă până la scopul produsului** (Fazele 0-rest + 1 + 2A + VG + 2B + 3, **fără CP**) | 1.10M–1.72M | ~120pp | ~13pp |
| **Plan complet** (tot ce e mai sus, inclusiv CP + Fazele 4–5) | 1.90M–2.87M | ~150–241pp | ~16–27pp |

Un "%5h echiv." de peste 100 nu înseamnă că se poate rula continuu peste limită — înseamnă că munca depășește o singură fereastră de 5 ore și se întinde pe mai multe sesiuni/zile de lucru, exact cum construcția Fazei 3 a worker-ului (46pp reale, ~538k tokeni) s-a întins pe o zi calendaristică lungă, nu pe o singură fereastră.

## De ce numerele astea și nu altele

- **CP e cea mai mare linie și cea mai incertă** — nu are niciun analog măsurat pe worker (nimic din worker nu face verification broker sandboxat sau consens multi-agent). E și opțională prin design (§7.9: "se păstrează doar dacă îmbunătățirea justifică repetat costul") — dacă mono-agent trece value gate-ul convingător, CP poate rămâne nefolosit mult timp, ceea ce ar tăia direct 43–64pp din estimarea "plan complet".
- **Faza 2A e cea mai sigură estimare** — e aproape identică ca formă cu Part B al worker-ului (provider de context, degradare explicită), deja măsurată la 93.9k tokeni pentru mecanica echivalentă.
- **Fazele 1 și 3 sunt "genuin noi"** (fără pattern intern de copiat în aceeași sesiune), deci NU beneficiază de discountul de 0.45–0.5× observat la Part B — sunt estimate mai aproape de intervalul brut, cum au fost și etapele "cu adevărat de la zero" din Faza 3 a worker-ului (Etapa 1, 76% din estimare; Etapa 10, cel mai mare bloc din tot Faza 3).
- **Faza 5 rămâne intenționat vagă** — planul însuși spune că se construiește "doar dacă" Faza 4 arată valoare; un interval de 150-300k reflectă incertitudinea reală, nu o estimare tehnică precisă.

## Recomandare metodologică

Din momentul în care începe implementarea Fazei 1, cel mai valoros lucru de făcut e să pornești pentru `ai-code-planner` un jurnal de checkpoint-uri identic cu `docs/BENCHMARKS.md` al worker-ului (start/end per etapă, `/usage` + `/context`). Istoricul de acolo arată consumul real venind la **~45–80%** din estimarea brută odată ce convențiile se stabilesc — deci după primele 2-3 etape reale din Faza 1, aceste numere ar trebui recalibrate în jos, nu folosite orb până la capăt.

## Costul real al Fazei 1, măsurat — 2026-08-16 (auditul cerut de user)

**Estimarea de mai sus (350k–550k tokeni) a fost de ~15–20× mai mică decât realitatea.** Date reale extrase din `evidence.json` per task (nu din raportul de sumar al `ai-code-worker`, care raportează `0` la orice task al cărui gate eșuează, chiar dacă motorul chiar a rulat și a costat bani real — un bug de raportare confirmat, nu o absență reală de cost):

| Task | cache-read | cache-write | output | cost $ |
|---|---:|---:|---:|---:|
| TYPES-AND-SCHEMA-VALIDATE | 1.85M | 89k | 41k | 1.70 |
| CLAUDE-ADAPTER | 481k | 42k | 14k | 0.60 |
| DECOMPOSER | 380k | 60k | 29k | 0.91 |
| LINTER | 1.41M | 68k | 71k | 1.90 |
| PROJECTION-AND-PLAN-FILE | 446k | 42k | 16k | 0.63 |
| CLI, încercarea 1 (întreruptă de rate-limit 429, **zero commit**) | 924k | 48k | 28k | 0.98 |
| CLI, încercarea 2 (reușită) | 2.04M | 165k | 78k | 2.78 |
| **TOTAL** (7 invocări reale pentru 6 task-uri logice) | **7.52M** | **514k** | **276k** | **9.49** |

### De ce, în ordinea impactului

1. **Cauza structurală dominantă: fiecare task e `claude -p --no-session-persistence`, complet izolat.** Niciun task nu moștenește contextul altuia — fiecare re-descoperă repo-ul de la zero (CLAUDE.md/AGENTS.md/README, schemele cerute, fișierele surori) prin apeluri reale de tool. Cache-ul Anthropic ține costul per-token jos, dar volumul re-citit la fiecare invocare e mare (~1M cache-read în medie per task). **Calibrarea `~11.7k tokeni/pp` din Faza 3 a worker-ului (folosită pentru estimarea de mai sus) vine dintr-o sesiune unică, cu continuitate completă de context — un model de cost fundamental diferit de "N subprocese independente, fiecare de la zero".** Aici e cea mai mare parte a discrepanței, nu o eroare de calcul aritmetic.
2. **Acceptance criteria foarte detaliate (alegere deliberată, învățată din Faza 0)** — 5-8 puncte tehnice per task. Corect pentru corectitudine (a redus dramatic rundele eșuate), dar e prompt mare repetat la fiecare invocare și împinge motorul spre mai multă explorare/verificare.
3. **Numărul de ture variază mult pe complexitate** — task-ul CLI a avut 31 de ture; fiecare tură retrimite tot ce s-a discutat până atunci, deci costul crește compus *în interiorul* aceluiași task.
4. **Două întreruperi reale de rate-limit de sesiune Claude**, una cu pierdere pură: prima încercare la CLI a costat $0.98 / 924k tokeni pentru zero commit (tăiată de limita de sesiune la mijloc), reluarea completă a mai costat încă $2.78.
5. **TYPES și LINTER au fost scumpe deși modeste ca linii de cod** — cereau citire atentă (TYPES: oglindire exactă a 4 scheme JSON; LINTER: verificare față de toate fixture-urile din Faza 0), nu scriere multă.

### Recalibrare pentru Fazele 2A-5

Estimările din tabelul de mai sus (secțiunea "Estimare de tokeni și procente pentru implementare") **nu mai sunt de încredere ca sunt** — au fost derivate din calibrarea greșită (sesiune unică vs. dispecerizare per-task izolată). Un predictor mai bun, pe baza celor 7 invocări reale de mai sus: **~1.1-1.3M tokeni totali (cache-read + cache-write + output) per task de complexitate medie**, **~$0.6-1.9 cost real per task**, cu task-urile "de citire" (care cer înțelegerea precisă a unor contracte existente, nu doar scriere de cod nou) la fel de scumpe ca cele "de scriere". Pentru o fază cu N task-uri similare ca formă cu cele din Faza 1, un estimat brut e **N × 1.2M tokeni ± 40%**, plus overhead pentru orice întrerupere reală de rate-limit (imprevizibilă, dar de bugetat cu o marjă, nu ignorată).
