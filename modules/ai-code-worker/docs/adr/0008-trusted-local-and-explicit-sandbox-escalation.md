# AICW-ADR-008: Backend local sincer și escaladare explicită a sandboxului Codex

- Status: acceptat
- Data: 2026-08-26
- Owner: developer experience
- Clarifică: [AICW-ADR-002](0002-execution-environments.md) și
  [AICW-ADR-003](0003-instruction-trust-and-run-authorization.md)

## Context

Profilul unei execuții descrie proprietățile cerute, nu dovada că host-ul le aplică.
Un proces local pornit cu `spawn`, chiar dacă primește un mediu redus, un timeout și o
limită de output, nu izolează implicit filesystem-ul sau rețeaua, nu limitează numărul
de procese și nu demonstrează anularea întregului process tree. A deriva capabilități
din câmpurile profilului ar transforma intenția în atestare.

Separat, `danger-full-access` pentru Codex elimină o barieră a motorului. Un incident
de compatibilitate al `workspace-write` nu poate justifica transformarea automată a
unui writer într-un proces fără sandbox.

## Decizie

### Capabilitățile sunt probate

Contractul runtime devine un `ExecutionBackend` cu două operații distincte:

```ts
interface ExecutionBackend {
  probe(profile: unknown): EnvironmentCapabilityReport;
  runSync(profile: unknown, command: CommandRequest): CommandResult;
  run(profile: unknown, command: CommandRequest): Promise<CommandResult>;
}
```

Resolverul selectează un backend după `kind`. Câmpurile profilului sunt cerințe.
`probe()` raportează numai controale aplicate de implementarea curentă și nu adaugă o
capabilitate doar pentru că profilul o declară.

### Backend-ul `trusted-local`

Backend-ul local de producție se numește `TrustedLocalExecutionBackend`. El poate
raporta numai:

- `environment-scrubbed`, când procesul primește exclusiv mediul construit de worker;
- `process-timeout`, limitat la procesul copil direct;
- `output-limits`, pentru limita de bytes aplicată stdout/stderr.

Nu raportează:

- restricționarea filesystem-ului ori un mount izolat al worktree-ului;
- blocarea rețelei pentru procesele repository-ului;
- o limită a numărului de procese;
- anularea verificabilă a întregului process tree.

Worktree-ul și scope guard-ul rămân controale de integritate Git, nu sandbox de host.
`trusted-local` este eligibil numai când profilul, configurația și autorizația îl cer
explicit; configurația trebuie să conțină simultan
`executionEnvironment.defaultProfile: "trusted-local"` și
`executionEnvironment.allowTrustedLocal: true`. Configurația aflată în repository
solicită numai eligibilitatea și nu poate emite autorizația. Aceasta trebuie furnizată
extern prin CLI/API cu `authorizedBy`, `reason`, `approvedAt` și `source`, apoi este
înghețată în `run-intent.json` și `authorization.json`. Schimbarea provenienței cere o
rulare nouă. Adapterele writer primesc binding-ul backend/profil verificat chiar înainte
de execuție. Evenimentul `execution.started` și raportul final păstrează capability
report-ul și avertismentul că limita este `host-process`, nu izolare de host.

### Profilul `isolated`

În distribuția curentă nu există un backend OS izolat probat. Resolverul întoarce
`UnavailableIsolatedExecutionBackend`, iar writer-ul autonom produce
`BLOCKED/ENVIRONMENT_UNAVAILABLE` înainte de pornirea motorului.

Un backend viitor poate fi container, VM, sandbox nativ sau runner remote. El devine
eligibil numai după probe negative, specifice platformei, pentru fiecare capabilitate
cerută. Numele backend-ului ori succesul unei comenzi triviale nu este suficient.

`FakeExecutionBackend` este mutat în suportul de teste și nu poate fi rezolvat de
runtime-ul de producție.

### Sandboxul Codex

Writer-ul Codex folosește implicit `workspace-write`; reviewer-ul rămâne `read-only`.
`danger-full-access` este permis numai dacă există o aprobare separată cu:

- `authorizedBy`;
- `reason`;
- `approvedAt`;
- `source` (`cli` sau `api`).

Numele canonic al actorului din contract este `authorizedBy`. Configurația din
repository poate solicita `danger-full-access`, dar nu poate furniza aprobarea care
acordă privilegiul.

Aprobarea este validată, publicată atomic create-new și legată write-once de rulare
în `sandbox-policy.json`, apoi reflectată în doctor, evenimentele motorului și raportul
final. Selectarea modului fără aprobare, o aprobare incompletă ori o încercare de a
schimba decizia produce `BLOCKED`. Worker-ul nu face retry și nu escaladează automat
de la `workspace-write` la `danger-full-access`. Regula se aplică oricărui writer
Codex, inclusiv unui candidat Codex ales din rutarea unui run pornit cu Claude; un
blocker de policy este terminal și nu este tratat drept motiv de fallback.

O eroare de permisiune în `workspace-write` poate bloca task-ul sau poate activa numai
fallback-ul de motor deja înghețat și autorizat; privilegiile candidatului curent nu
cresc.

## Consecințe

- `doctor` poate raporta corect că profilul `isolated` nu este disponibil pe host-ul
  curent, în loc să ofere o garanție falsă.
- Pilotul local cu repository controlat rămâne posibil, dar cere opt-in explicit și
  păstrează riscul în evidence.
- Configurațiile Codex care se bazau pe defaultul privilegiat trebuie migrate la
  `workspace-write` sau completate cu aprobarea explicită.
- O incompatibilitate upstream este vizibilă ca blocaj, nu ca motiv pentru escaladare
  silențioasă.

## Alternative respinse

- Capabilități derivate din JSON-ul profilului: confundă cerința cu enforcement-ul.
- Redenumirea vechiului backend fără schimbarea raportului: păstrează garanția falsă.
- Worktree plus diff drept sandbox: nu previne citirea ori efectele în afara Git.
- `danger-full-access` implicit pe o platformă cunoscută ca problematică: extinde
  privilegiile fără consimțământ și nu este fail-closed.
- Backend fake disponibil în producție: permite trecerea preflight-ului cu dovezi
  simulate.

## Criterii de acceptare

1. `trusted-local` raportează exclusiv capabilitățile pe care le aplică efectiv.
2. Un profil `isolated` nu poate porni writer-ul fără backend probat.
3. Lipsa opt-in-ului `allowTrustedLocal` blochează backend-ul local.
4. Backend-ul fake este importabil numai din suportul de teste.
5. Defaultul Codex este `workspace-write` în doctor și în toate căile de run.
6. `danger-full-access` fără aprobarea completă este blocat înainte de motor.
7. Aprobarea este write-once, nu poate proveni din configurația repository-ului și
   apare în doctor, evenimente și raport.
8. O eroare `workspace-write` nu produce o invocare ulterioară privilegiată.
