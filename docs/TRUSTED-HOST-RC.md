# RC v1 intern — trusted-host explicit, fără Docker

Decizia maintainerului: 2026-09-14. Candidat: `1.0.0-rc.1-internal`.
Acest profil înlocuiește obiectivul imediat de calificare izolată, nu dovedește
production-readiness corporate și nu primește scorul >=8,5/10 din planurile amânate.

## Activare

Implicit rămâne profilul care refuză un provider fără backend izolat. Nu există
fallback automat din Docker/local-isolated în execuție host. Activarea este alegerea
explicită a profilului `kind: trusted-local`, `providerExecution.mode: host-process`,
`acknowledgeHostAccess: true`. Template-ul permite inițial numai Codex.

Din rădăcina bundle-ului construit, pentru un proiect de încredere:

```text
node dist/src/cli.js init --repo <proiect> --mode integrated --full --profile generic --execution-profile modules/ai-code-worker/templates/project/.ai-code-worker/execution-environment.trusted-host.example.json --verify
```

Pentru stack-ul .NET/Next.js se selectează `--profile dotnet-nextjs` și layout-ul real.
Pentru o instalare existentă, schimbările managed necesită explicit `--repair`; consultați
preview-ul/configurația și păstrați modificările utilizatorului. Nu executați această
comandă asupra unui repository necunoscut: `--verify` poate rula validările lui pe host.

Installerul importă profilul în `.ai-code-worker/execution-environment.example.json`.
Acesta este fișierul activ, în pofida sufixului istoric `example`; un alt nume nu activează
profilul. Planul acceptat, autorizarea run-ului și hash-ul profilului rămân obligatorii.

```text
node modules/ai-code-worker/dist/src/cli.js doctor --repo <proiect> --engine fake --json
node dist/src/cli.js run --repo <proiect> --plan <plan-acceptat> --engine codex --json
```

Prima comandă verifică profilul fără task LLM; a doua invocă providerul și poate consuma
quota. Autentificarea providerului trebuie pregătită separat. HOME/profile directories
sunt accesibile cu drepturile utilizatorului, inclusiv credential stores locale. Pentru
autentificare prin variabilă, adăugați NUMELE ei în `credentialVariables` și în
`allowedVariables`; valoarea rămâne externă repository-ului. Nu activați moștenirea
întregului mediu. Provider/model/fallback nu se schimbă implicit.

## Ce protejează și ce nu protejează

- Filtrează variabilele de mediu, limitează timpul direct/async și output-ul capturat;
  watchdog-ul nu poate extinde plafonul profilului.
- Păstrează worktree-uri, criterii, bugete, autorizări și evidence cu
  `backend: trusted-host`, `securityBoundary: host-process`.
- NU restrânge accesul OS la fișiere sau rețea. Permisiunile sunt cele ale contului;
  orice shell, hook, MCP sau script repository poate avea aceleași drepturi.
- NU izolează CPU/memorie/număr de procese; câmpurile comune din schema limitelor
  nu reprezintă garanții OS. Cleanup-ul arborelui de procese este best-effort.
- Un worktree și un diff allowlist nu sunt sandbox. Se recomandă cont fără drepturi
  administrative, backup și evitarea datelor/credentialelor de producție.
- `providerSupported: true` înseamnă rută de execuție disponibilă, nu autentificare
  validată sau task live reușit. Doctor păstrează avertismentele vizibile.
- Gate-ul `isolation-preflight` și publicarea stabilă continuă să refuze acest profil.

## Calificarea acestui RC intern

```text
node scripts/solo-release-audit.mjs --candidate v1.0.0-rc.1-internal --out dist-release/trusted-host-rc-audit.json
```

Auditul rulează verificările locale, regresiile trusted-host cu procese/CLI de test,
packaging, instalare curată, upgrade/rollback și integritatea artefactelor. Nu invocă
un LLM real și nu publică. Un rezultat `SOLO_INTERNAL_RC_READY` nu certifică securitate
corporate, probe live, toate platformele sau inventarul complet al dependențelor.
SBOM-ul actual este un inventar de fingerprints ale lockfile-urilor; inventarul
tranzitiv complet rămâne în backlog, împreună cu Docker și calificarea >=8,5/10.

Publicarea, tag-ul public, probele live cu buget și calificarea stabilă sunt decizii
separate. [TODO](../todo.md) păstrează integral planurile amânate și starea RC-ului.
