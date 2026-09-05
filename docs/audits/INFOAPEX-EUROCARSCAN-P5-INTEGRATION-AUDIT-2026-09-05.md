# Audit de integrare Infoapex-AI ↔ EuroCarScan — P5

**Data:** 2026-09-05  
**Scop:** diagnosticarea completă a traseului `benchmark → Infoapex root → ai-code-worker → plan → provider`, fără extinderea matricei P5 după prima anomalie.

## Rezumat executiv

Preflight-ul deterministic este sănătos, iar aplicația consumator C# compilează și trece testele. Blocajul nu este în EuroCarScan, ci în contractul de integrare al workerului și în observabilitatea execuției. Un canary Codex direct a depășit timeout-ul de 120 s, iar canary-ul full-ICM s-a închis cu exit code 2 fără rezultat structurat. În consecință, P5 este `BLOCKED/INCONCLUSIVE`; Claude și matricea completă nu au fost pornite.

## Inventarul erorilor

| ID | Simptom observat | Cauză | Corecție / stare |
|---|---|---|---|
| INT-01 | Prima felie EuroCarScan a fost implementată în Python/Flask | Planul inițial a presupus reutilizarea pilotului și a ales o arhitectură neconfirmată de utilizator | Arhitectura canonică este acum C# / ASP.NET Core, Python doar ML/data, React/Next/TS; auditul este păstrat în repository-ul consumator |
| INT-02 | Workspace-urile benchmark copiau aproximativ 410 MB de `frontend/node_modules` și cache-uri | Izolarea copia directoare generate care nu fac parte din sursa evaluată | Filtrare în `ai-code-benchmark` pentru `.git`, `node_modules`, `.next`, `bin`, `obj`, cache-uri Python; workspace-ul canary a scăzut la aproximativ 1,2 MB; rezolvat |
| INT-03 | Canary Codex direct a depășit 120 s | Execuția providerului nu a produs rezultat în limita configurată; cauza internă exactă nu poate fi dedusă din envelope-ul actual | Rămâne incident de provider/worker; trebuie păstrat ca timeout bounded, fără retry automat sau extindere de timeout în benchmark |
| INT-04 | Canary full-ICM a ieșit cu cod 2 în aproximativ 1,6 s, fără JSON structurat | Root CLI a fost invocat fără `--json`, iar benchmarkul nu putea vedea finding-ul intern; exit code-ul a fost redus la mesaj generic | `InfoapexRootAdapter` trimite acum explicit `--json`; testul fake cere acest flag; rezolvat pentru execuțiile viitoare |
| INT-05 | Un `stateRoot` configurat în `.ai-code-worker/config.json` era ignorat la compile/status/checkpoint | Aceste componente chemau `resolveStateRoot` fără `configuredStateRoot` | Compile, status și usage checkpoint folosesc acum configurația publică; test de regresie adăugat; rezolvat |
| INT-06 | Diagnosticul full-ICM este insuficient: `Adapter process exited unsuccessfully with code 2` | Adapterul persista doar status/exit code și hash, fără finding public | `parseInfoapexFailure` extrage bounded `findings[].code` și mesajul redacted, fără stdout/stderr brut; implementat și testat, validarea live rămâne pending |
| INT-07 | `health`/`brief` ale providerului `ai-code-control` pot raporta unavailable/error într-un workspace nou | Cache-urile de memory/codegraph nu există până la inițializare/refresh; aceste verificări sunt advisory, dar pot crea confuzie în canary | Trebuie introdus un preflight explicit pentru control-plane: `init`, health, brief și context-compile, cu statusuri separate și fără a le confunda cu execuția providerului |
| INT-08 | Configurația benchmarkului și modelul promptului nu erau legate explicit de arm | Runnerul putea ajunge la valori hardcodate diferite de experimentul înghețat | Runnerul folosește modelul/efortul/sandbox-ul din armul înghețat; experimentul curent este `gpt-5.6-luna / medium`; rezolvat |
| INT-09 | Baseline-ul consumator devenea stale după commituri de documentație | Suitele cereau potrivire exactă de HEAD, chiar când fișierele taskului nu se schimbaseră | Verificarea permite descendent Git doar dacă baseline-ul este ancestor și căile taskului sunt byte-unchanged; modificările relevante cer experiment nou; rezolvat |
| INT-10 | Rularea completă ar fi consumat provider quota înainte de validarea workerului | Canary-ul nu era o poartă suficient de strictă pentru integrarea reală | Runnerul este folosit cu `--maximum-new-observations 1`; la prima anomalie se oprește; procedura este acum obligatorie |

### Incidente adaugate la reluarea P5

| ID | Simptom | CauzÄƒ | Stare |
|---|---|---|---|
| INT-11 | Planul sintetic consumer a fost respins cu `MANIFEST_INVALID` | Lipseau campurile obligatorii `globalGates` si `budgets` | Runner corectat cu manifest v1.1 complet si bugete bounded |
| INT-12 | Git a esuat cu `WORKTREE_CREATE_FAILED` / `fatal: '$GIT_DIR' too big` | `stateRoot` era sub `evidence/workspaces`, generand cai administrative prea lungi pe Windows | Runnerul foloseste state root bounded sub radacina benchmarkului |
| INT-13 | Full-ICM a ajuns la gate, dar `dotnet test` a iesit cu exit 1; candidate a depasit timeout-ul de 120 s | Gate-ul C# nu este inca preflight-uit intr-un workspace curat; executia candidate nu a produs rezultat bounded | P5 oprit dupa doua observatii; este necesar experiment nou dupa stabilizare |

## Dovezi reproducibile

- Infoapex root tests: **26/26 PASS**.
- EuroCarScan backend: **3/3 PASS**.
- Frontend: typecheck/build PASS; `npm audit --omit=dev --audit-level=high`: **0 vulnerabilități**.
- Worker doctor Codex și Claude: **PASS**.
- Direct Codex: `TIMEOUT`, limită 120 s.
- Full-ICM Codex: `BLOCKED`, exit code 2, fără usage/diff/evidence capture.
- Raportul canary: `INCONCLUSIVE`, runtime `INTERRUPTED`; o singură observație evaluată, restul skipped.

## Blocaj rămas

Defectul rămas este diagnosticarea și stabilizarea contractului root → worker → plan pentru un workspace nou. Nu este permisă lansarea Claude sau a celor 27/30 de observații până când un canary full-ICM produce un envelope JSON valid, un finding public dacă este blocat și evidence minimal pentru execuție.

## Remedieri obligatorii înainte de un nou canary

1. Adăugarea unui parser de failure pentru envelope-ul root: `status`, `findings[].code`, mesaj redacted, `runId`, `compile.status`.
2. Preflight control-plane separat: inițializare control, health, brief și `context-compile` pentru planul generat.
3. Test fake end-to-end pentru: plan acceptat → root `--json` → worker blocked/done → evidence.
4. Verificarea că `stateRoot` configurat este folosit de compile, status, checkpoint, worktree și telemetry.
5. Un singur canary nou; numai dacă trece se autorizează Claude și matricea P5.

## Rezultatul reluarii P5 (canary bounded)

- Observatia 1 (`full-icm`, `api-not-found`) a trecut de compilare si worktree, apoi a fost blocata la gate-ul `dotnet test` cu exit 1 (`TASK_GATE_FAILED`). Testul a trecut manual ulterior in acelasi worktree, deci trebuie izolata diferenta de restore/executie a gate-ului.
- Observatia 2 (`candidate`, `api-not-found`) a depasit timeout-ul providerului de 120 s; nu s-a obtinut envelope, diff sau usage comparabil.
- Rularea a fost oprita dupa doua observatii. Claude si restul matricei nu au fost lansate.
- Verdictul ramane `REJECT`; rezultatul nu autorizeaza comparatia P5 si cere experiment/autorizare noi dupa stabilizare.
- Investigatia gate-ului a identificat si `INT-14`: environment scrub-ul workerului
  pastra doar PATH/SystemRoot, insuficient pentru restore dotnet/NuGet. Workerul
  permite acum doar caile standard de profil/cache (HOME, USERPROFILE,
  LOCALAPPDATA, APPDATA, TEMP/TMP, DOTNET_ROOT, NUGET_PACKAGES), fara variabile
  arbitrare sau secrete; testul de regresie este verde.
- Timeout-ul candidatului a fost separat de `REJECT`: procesul root, task-ul worker
  si Codex aveau aceeasi limita de 120 s, astfel wrapper-ul putea fi terminat exact
  cand workerul incerca sa emita finding-ul structurat. `InfoapexRootAdapter` are acum
  o marja de teardown de 15 s; un timeout real va fi raportat ca `TIMEOUT/BLOCKED`,
  nu ca un timeout opac al wrapper-ului.

## Politica de interpretare

Un `BLOCKED` sau `TIMEOUT` de infrastructură nu este succes și nu este atribuit automat aplicației. Un raport fără envelope structurat, diff, usage sau evidence este `INCONCLUSIVE`, nu poate susține o comparație de modele și nu poate fi folosit pentru acceptarea P5.
