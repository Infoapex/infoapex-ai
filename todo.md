# Infoapex AI TODO

## NEW-PROJECT-ONBOARDING (obligatoriu inainte de prima rulare)

Acest checklist este rezultatul auditului EuroCarScan din 2026-09-05. Un proiect
nou nu este autorizat pentru o matrice P5 pana cand toate verificarile de mai jos
au status PASS. Orice FAIL opreste rularea si produce un incident nou in acest
registru; nu se mareste timeout-ul si nu se porneste automat un alt provider.

1. **Arhitectura si contractul:** confirma explicit stack-ul (backend, ML/data,
   frontend) in ADR-ul proiectului inainte de generarea planului. Planul trebuie
   sa fie acceptat si sa contina `workerContractVersion`, `globalGates` si toate
   campurile obligatorii din `budgets`.
2. **Git si baseline:** repository Git curat, commit de referinta inghetat, suitele
   si task-urile indica aceeasi revizie. Schimbarile ulterioare cer suite,
   experiment si autorizare noi.
3. **Gate preflight:** ruleaza manual fiecare comanda de verificare intr-un
   checkout/worktree curat (restore, build si test). Nu considera PASS un gate care
   trece doar dupa o rulare manuala ulterioara.
4. **Configurare worker:** `ai-code-worker init`; `config.json` trebuie sa declare
   engine-ul, modelul, efortul, sandbox-ul, `contextPackage.mode`, adapter-ele si un
   `stateRoot` extern, bounded si suficient de scurt pentru Windows. State-ul nu se
   pune sub `evidence/workspaces`.
5. **Doctor si provideri:** `doctor` pentru fiecare provider autorizat; versiunea,
   executable-ul, modelul, efortul si permisiunile se copiaza din armul inghetat.
   Lipsa credentialelor sau quota produce BLOCKED, niciodata fallback implicit.
6. **Control-plane:** initializeaza `ai-code-control`, apoi verifica separat
   health, brief si `context-compile` pentru planul generat. Un control-plane
   unavailable nu trebuie confundat cu un esec al providerului.
7. **Compile JSON:** ruleaza root CLI cu `--json`, verifica `compile.status`,
   `manifestSha256`, autorizarea legata de acel hash si ca nu exista
   `MANIFEST_INVALID`, `PLAN_NOT_ACCEPTED` sau `STATE_ROOT` divergence.
8. **Canary bounded:** ruleaza mai intai fake end-to-end, apoi maximum o observatie
   reala pentru `full-icm` si una pentru `candidate`. Evidence trebuie sa includa
   envelope JSON, finding redacted, diff, gate si usage. La prima anomalie se opreste.
9. **Izolare si cai:** workspace-ul trebuie sa excluda `.git`, `node_modules`,
   `.next`, `bin`, `obj` si cache-uri generate; verifica lungimea caii worktree si
   faptul ca worktree-ul poate fi creat si curatat.
10. **Autorizare P5:** numai dupa canary PASS se semneaza autorizarea pentru matricea
    completa. Claude, candidate capability si orice backend remote au autorizari
    separate; nu se reutilizeaza un hash de experiment vechi.

## Registru permanent al blocajelor root -> worker -> plan

- **INT-01 Arhitectura presupusa:** EuroCarScan a pornit in Python/Flask fara o
  decizie aprobata. Rezolvare: ADR obligatoriu inainte de plan; stack-ul aprobat
  este C# / ASP.NET Core, Python doar ML/data, React/Next/TypeScript.
- **INT-02 Workspace supradimensionat:** copierea `node_modules` si a cache-urilor
  a ajuns la aproximativ 410 MB. Rezolvare: izolarea exclude artefactele generate.
- **INT-03 Timeout provider:** Codex direct a depasit limita de 120 s. Rezolvare:
  timeout bounded, fara retry sau crestere automata; incidentul ramane evidence.
- **INT-04 Root fara JSON:** root CLI a fost invocat fara `--json`, pierzand finding-ul.
  Rezolvare: adapterul root adauga explicit `--json` si parseaza doar finding-ul
  bounded/redacted.
- **INT-05 State root ignorat:** compile/status/checkpoint foloseau state-ul implicit.
  Rezolvare: toate componentele citesc `config.json:stateRoot`.
- **INT-06 Diagnostic generic:** exit code-ul singur nu permitea diagnostic. Rezolvare:
  `parseInfoapexFailure`, cu cod si mesaj bounded, fara stdout/stderr brut.
- **INT-07 Control-plane fresh:** health/brief pot fi unavailable in workspace nou.
  Rezolvare: preflight separat init -> health -> brief -> context-compile.
- **INT-08 Drift de arm:** modelul/efortul puteau diferi de experiment. Rezolvare:
  runnerul copiaza valorile din experiment si le verifica in config.
- **INT-09 Baseline stale:** documentatia schimba HEAD fara sa schimbe task-urile.
  Rezolvare: se accepta doar descendenti cu task paths byte-unchanged; altfel hash nou.
- **INT-10 Extindere prematura:** matricea completa consuma quota inaintea validarii.
  Rezolvare: `--maximum-new-observations 1` si stop la prima anomalie.
- **INT-11 Plan incomplet:** planul sintetic EuroCarScan lipsea `globalGates` si
  `budgets`, producand `MANIFEST_INVALID`. Rezolvare: generatorul produce manifest
  v1.1 complet si bugete bounded.
- **INT-12 Cale Windows prea lunga:** state-ul sub `evidence/workspaces` a produs
  `fatal: '$GIT_DIR' too big`. Rezolvare: state root bounded la radacina benchmarkului.
- **INT-13 Gate/provider instabil:** full-ICM a primit `dotnet test` exit 1, iar
  candidate a expirat la 120 s; testul C# a trecut manual ulterior. Rezolvare
  implementata partial: harness-ul face preflight restore/build/test, iar workerul
  pastreaza caile standard HOME/USERPROFILE/NuGet pentru gate-uri, fara secrete.
  Rerularea cu experiment/autorizare noi ramane obligatorie; Claude si matricea
  raman blocate pana la canary PASS.
- **INT-14 Environment scrub prea strict pentru toolchain:** quality gate-urile
  primeau doar PATH/SystemRoot, iar restore-ul dotnet/NuGet putea iesi cu code 1
  chiar daca testul trecea manual. Rezolvare: allowlist explicit pentru HOME,
  USERPROFILE, LOCALAPPDATA, APPDATA, TEMP/TMP, DOTNET_ROOT si NUGET_PACKAGES;
  secretele si variabilele arbitrare raman eliminate, cu test de regresie.

## Regula de inchidere pentru onboarding

Un proiect nou poate fi declarat READY numai cu: baseline Git inghetat, plan v1.1
validat, autorizare cu hash concordant, doctor PASS, control-plane PASS, gate
preflight PASS, canary full-ICM PASS si canary candidate PASS. Un raport `REJECT`,
`INCONCLUSIVE`, `BLOCKED` sau `TIMEOUT` nu se reinterpreteaza ca succes.

- **P4.5/BENCH este închis, iar primul candidat P5 este acceptat intern.** OpenTelemetry redactat R2 are 20/20 observații valide, 10 perechi, coverage `0 → 1`, zero leakage, zero regresie funcțională și overhead CI superior `+3,00%` față de pragul `+5%`; verdict `ACCEPT`. R1 s-a oprit fail-closed după 2 apeluri și rămâne imuabil. Rezultatul este în `validation/benchmark/p5-candidates/opentelemetry-redacted-v2/LIVE-EVALUATION-R2.json`. Următorul subproiect recomandat este UI-ul local read-only pentru run/evidence, după feedback real din minimum un proiect consumator.
- **P2 closed 2026-09-02, `economicVerdict: comparable` on both P2-A and P2-B.** P2-A (2-invocation preflight) and P2-B (10-task live pilot, `scripts/p2-b-live-pilot.mjs`, `validation/p2-b/live-report.json`) are both functional PASS: 10/10 DONE, 10/10 accurate (script-verified, not self-reported), zero engine fallbacks, `GRAPH-06` disabled throughout. Fixed a real bug found while investigating Codex's gap: `ai-code-worker`'s Codex usage parser never read `cache_write_input_tokens`, even though real CLI 0.147.0 rollouts do contain it — fixed in `codex-cli.ts`/`read-codex-session.ts`. Separately, since both Codex and Claude here run on flat-rate ($20/mo) subscriptions (not pay-per-token API billing), `costUsd` was redefined out of `economicVerdict` entirely: both engines' rollouts/output already carry a real 5-hour rate-limit percentage (`rate_limits.primary` for Codex - measured; a calibrated tokens-per-point ratio for Claude - estimated, since it has no local %5h reading at all), so `economicVerdict` is now `comparable` whenever that percent is known, regardless of `costUsd`. New: `src/usage/quota-usage.ts`, `run-report.json`'s `quotaUsage` field (auto-populated for every real run, not just the P2 pilots), `estimate.ts`'s self-calibrating Codex percent estimator (every completed real Codex run is its own calibration point), and an optional post-hoc `maximumRunFiveHourPercent` budget in `manifest.schema.json`. `costUsd` itself remains unavailable for Codex, confirmed structural not a parsing gap: `rate_limits.credits` shows `has_credits: false, balance: "0"` for this ChatGPT-Plus-subscription account — no dollar ledger exists in this billing mode; that fact just no longer blocks comparability. 409/409 worker tests pass. Before building, confirmed `/usage`/`/context` are Claude Code TUI-only commands with no CLI/API surface and do not apply to headless per-task invocations.
- Open, needs a manual step: adding a P2-B-era Claude calibration point to `claude-calibration.ts`'s seeded table requires a real `/usage` (%5h) reading taken immediately before/after a live Claude run — the 6 existing seeded points are all from 2026-08-14 dev sessions, not production-shaped tasks like P2-B's. Codex's calibration self-updates automatically from every real run and does not have this gap.
- The sequential baseline `GRAPH-06`'s A/B experiment depended on now exists (P2-B above). Enabling `GRAPH-06` parallel reviewers remains a separate, distinct decision — run the preregistered A/B experiment only with its own explicit authorization; P2 closing does not itself authorize it.
- **P3 este închis și publicat.** `v0.1.0` există ca GitHub Release privat, cu ZIP, SHA-256 și manifest. Smoke test-ul clean-extract trece 10/10, iar matricea CI Windows/Linux este verde. Codul curent de pe `main` include schimbări ulterioare release-ului și va necesita o versiune nouă după închiderea P4.5.
- Keep provider-neutral discovery for Gemini, Grok, Kimi and other CLIs as future scope; the current native worker engines are `fake`, `codex` and `claude`.
