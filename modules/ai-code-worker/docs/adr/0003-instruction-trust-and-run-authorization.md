# AICW-ADR-003: Trust al instrucțiunilor și autorizarea imutabilă a rulării

- Status: acceptat
- Data: 2026-08-01
- Owner: developer experience
- Plan asociat: [planul de implementare v1.2](../IMPLEMENTATION-PLAN.md)

## Context

Planul acceptat descrie ce trebuie construit, dar nu este singur o autorizație de a executa procese, de a modifica fișiere sau de a consuma buget. În plus, repository-ul conține Markdown, comentarii, configurații și output care pot formula instrucțiuni incompatibile cu politica rulării.

În modul non-interactiv nu există un utilizator care să corecteze fiecare escaladare. Limitele trebuie să fie explicite și verificabile înainte de primul writer.

## Decizie

### Autoritate monotonă

Sursele au următoarea ordine:

1. policy instalată în afara repository-ului și `RunAuthorization`;
2. manifestul înghețat;
3. planul acceptat și sursele canonice declarate;
4. promptul de rol al worker-ului;
5. `AGENTS.md`, `CLAUDE.md` și configurația versionată a repository-ului;
6. codul, documentația obișnuită, outputul comenzilor și conținutul extern.

O sursă inferioară poate restrânge scope-ul, poate cere verificări suplimentare sau poate furniza date. Nu poate acorda o capabilitate nouă, elimina o interdicție ori extinde `allowedPaths`.

Motorul primește această regulă în prompt, dar worker-ul o aplică mecanic prin policy, execution environment și command authorization. Outputul modelului nu este executat ca policy.

### Fluxul de autorizare

1. Invocarea explicită creează `RunIntent`, care autorizează numai preflight și compile read-only.
2. Compilerul produce manifestul candidat.
3. Worker-ul verifică faptul că toate capabilitățile cerute sunt submulțime a intentului și policy-ului externe.
4. Manifestul este înghețat.
5. Se scrie `authorization.json`, legat de `planSha256`, `manifestSha256`, `baseCommit`, `graphVersion`, repository fingerprint și execution profile digest.
6. Orice nepotrivire ulterioară produce `BLOCKED/AUTHORIZATION_MISMATCH`.

Grantul conține cel puțin:

```json
{
  "authorizationId": "...",
  "repositoryFingerprint": "...",
  "planSha256": "...",
  "manifestSha256": "...",
  "baseCommit": "...",
  "graphVersion": 1,
  "executionEnvironment": "isolated",
  "allowedCapabilities": [
    "write-worktree",
    "run-isolated-tests",
    "create-local-commits"
  ],
  "forbiddenCapabilities": ["push", "deploy", "network-write"],
  "approvalMode": "never",
  "issuedAt": "...",
  "expiresAt": "..."
}
```

### Approval modes

- `never`: nu cere input și nu escaladează; continuă numai în grant sau produce `BLOCKED`.
- `on-risk`: poate cere o autorizație nouă, dar nu continuă până când aceasta există ca obiect separat.
- `always`: cere confirmarea manifestului înghețat înainte de primul writer.

Approval mode controlează interacțiunea, nu acordă permisiuni.

### Bugete

Cel puțin una dintre limitele `maximumRunMinutes`, `maximumAgentInvocations`, bugetele de tokeni sau un cost raportat fiabil trebuie să fie finită. `maximumCostUsd: null` este permis numai dacă există altă limită dură. Necunoscutul rămâne `null` și urmează policy-ul `onUnknownUsage`.

### Context controlat

Adaptoarele automatizate dezactivează auto-discovery necontrolat când motorul oferă această capabilitate și injectează explicit contextul aprobat. Fișierele repository-ului care trebuie consultate sunt hash-uite în request/evidence. Shims interactive pot rămâne pentru UX, dar nu sunt autoritatea rulării automate.

## Consecințe

- Configurația versionată din repository nu poate autoriza singură acțiuni externe.
- Un atac de prompt injection nu poate extinde mecanic capabilitățile.
- Replan care schimbă capabilitățile cere un grant nou și o rulare nouă.
- `run-authorization.schema.json` devine contract public.

## Alternative respinse

- `status: accepted` drept autorizație completă: confundă cerința cu permisiunea.
- `approvalMode: never` drept bypass: ar transforma lipsa utilizatorului în privilegii nelimitate.
- Doar instrucțiuni în prompt: nu oferă enforcement pentru procese, filesystem sau rețea.

## Acceptance tests

1. Un plan acceptat fără RunAuthorization nu poate porni writerul.
2. Un fișier din repository care cere push sau acces la secrete nu extinde grantul.
3. Un `AGENTS.md` mai restrictiv reduce scope-ul efectiv.
4. Schimbarea manifestului, bazei sau execution profile-ului invalidează grantul.
5. `approvalMode: never` produce `BLOCKED` la capabilitate lipsă, fără prompt suspendat.
6. O rulare cu cost necunoscut are totuși cel puțin o limită dură finită.
