# P6 developer quickstart

Acest ghid este pentru un dezvoltator care folosește Infoapex AI dintr-un repository
consumator. Profilul implicit `core-local` nu face upload, nu păstrează conversații brute
și nu activează acțiuni externe.

## Quickstart local, fără provider

`--full` trebuie rulat într-un repository Git care are deja cel puțin un commit, iar
utilizatorul curent trebuie să aibă drept de scriere în repository. Installerul creează
și validează fișierele de configurare ale modulelor, dar nu acordă ACL-uri Windows și nu
instalează Node.js, .NET, Python, Codex sau Claude. Aceste dependențe și politica de
permisiuni a motorului rămân responsabilitatea mediului de execuție.

Din root-ul bundle-ului construit:

```bash
npm ci --ignore-scripts
npm run build
node dist/src/cli.js init --repo /cale/catre/proiect --mode integrated --full --profile generic --verify
```

După provisioning-ul extern al backendului Docker și al proxy-ului de egress, un
profil operator validat poate fi importat atomic la instalare:

```bash
node dist/src/cli.js init --repo /cale/catre/proiect --mode integrated --full \
  --profile dotnet-nextjs --execution-profile /cale/catre/execution-profile.json --verify
```

Profilul este validat prin schema `ai-code-worker` înainte de prima scriere. Installerul
nu copiază valori de credentiale și nu creează automat network-ul, proxy-ul sau ACL-uri.
Un profil invalid produce `BLOCKED` fără stare de instalare parțială.

`--verify` rulează imediat după instalare gate-ul `preflight`, fără să invoce un
provider de coding. Dacă verificarea eșuează, comanda returnează `BLOCKED`; nu există
un succes intermediar care să ascundă o instalare incompletă. Pentru un target deja
configurat, `--repair` este necesar înainte de înlocuirea fișierelor managed diferite.

`preflight` și `install --check` includ verificările `repository-filesystem-access` și
`bundle-read-access`. Acestea testează accesul efectiv al utilizatorului curent la
starea installerului și la runtime-urile modulelor. Installerul nu acordă ACL-uri
Windows și nu ridică privilegii; dacă un check este `BLOCKED`, administratorul
repository-ului trebuie să corecteze ACL-ul sau să mute proiectul într-o locație
accesibilă, apoi să ruleze din nou verificarea.

Full install-ul creează și `.ai-code-benchmark/config.json`, cu căile exacte către
root CLI și ai-code-control. Benchmarkul rămâne dezactivat pentru execuție live și
nu primește automat un state root; pilotul live necesită autorizarea sa explicită.

Pentru primul run, folosește motorul determinist `fake` și un plan acceptat, revizuit de
operator. Acest pas verifică wiring-ul și gate-urile, nu calitatea unui provider:

```bash
node dist/src/cli.js run --repo /cale/catre/proiect \
  --plan Plan/FIRST-RUN.md --run-id first-run --engine fake
```

Ținta de onboarding este primul run fake în maximum 15 minute. Scriptul
`node scripts/dx-quickstart-check.mjs` reproduce acest flux într-un repository temporar,
fără provider și fără a scrie în repository-ul consumator.

## Prima execuție live autorizată

1. Rulează `preflight` și rezolvă toate rezultatele `BLOCKED`.
2. Verifică planul, manifestul, providerul și sandbox-ul în raportul `doctor`.
3. Folosește explicit `--engine codex` sau `--engine claude`; fallback-ul implicit este
   dezactivat de politica de producție.
4. Începe cu un task bounded și păstrează `runId`, commitul și gate-urile.
5. Pentru întrerupere, folosește `resume` numai cu un `runId` existent.

Un provider indisponibil este raportat ca `BLOCKED`; produsul nu schimbă silențios providerul.

## Operare și feedback

```bash
node dist/src/cli.js production health --repo /cale/catre/proiect
node dist/src/cli.js diagnostics bundle --repo /cale/catre/proiect
node dist/src/cli.js production retention --repo /cale/catre/proiect
```

Bundle-ul de diagnostics este local, redacționat, hash-uit și limitat la 256 KiB. Revizuiește
conținutul înainte de orice transfer aprobat; nu există upload automat.

Exemplele copiable pentru TypeScript, .NET și monorepo sunt în `examples/p6/`.
