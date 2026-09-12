# P6 developer quickstart

Acest ghid este pentru un dezvoltator care folosește Infoapex AI dintr-un repository
consumator. Profilul implicit `core-local` nu face upload, nu păstrează conversații brute
și nu activează acțiuni externe.

## Quickstart local, fără provider

Din root-ul bundle-ului construit:

```bash
npm ci --ignore-scripts
npm run build
node dist/src/cli.js init --repo /cale/catre/proiect --mode integrated --full --profile generic
node dist/src/cli.js preflight --repo /cale/catre/proiect
```

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
