# AICW-ADR-002: Medii de execuție și izolarea proceselor

- Status: acceptat, amendat de [AICW-ADR-008](0008-trusted-local-and-explicit-sandbox-escalation.md)
- Data: 2026-08-01
- Owner: developer experience
- Plan asociat: [planul de implementare v1.2](../IMPLEMENTATION-PLAN.md)

## Context

Git worktree izolează checkout-uri și referințe de lucru, dar nu limitează accesul unui proces la filesystem, rețea, variabile de mediu, credențiale sau procese copil. Codul controlat de repository poate fi executat de motor, quality gates, hook-uri, build-uri, package lifecycle scripts și generatoare.

Verificarea diff-ului după execuție detectează numai o parte din efecte și nu poate demonstra că un proces nu a citit ori transmis date din afara worktree-ului.

## Decizie

Se introduce un contract unic `ExecutionEnvironment` pentru orice proces care poate executa cod controlat de repository.

```ts
type ExecutionEnvironmentKind = "trusted-local" | "isolated";

interface ExecutionEnvironment {
  doctor(profile: EnvironmentProfile): Promise<EnvironmentCapabilityReport>;
  prepare(request: EnvironmentRequest): Promise<EnvironmentHandle>;
  execute(
    handle: EnvironmentHandle,
    command: CommandSpec,
    signal: AbortSignal
  ): AsyncIterable<ProcessEvent>;
  dispose(handle: EnvironmentHandle): Promise<void>;
}
```

### Profilul `isolated`

Este implicit pentru writer autonom, repository cu trust necunoscut și orice rulare care folosește `approvalMode: "never"`, dacă authorization grant-ul nu cere explicit alt profil.

Trebuie să ofere:

- root filesystem read-only în afara mount-urilor declarate;
- worktree writeable și state/evidence mounts separate;
- fără mount pentru profilul utilizatorului, SSH agent, credential stores ori socket-uri de administrare;
- environment scrubbed, apoi allowlist explicit;
- network deny pentru procesele repository-ului;
- egress separat și minim către providerul AI numai pentru control-plane-ul adaptorului;
- limite CPU, memorie, număr de procese, timp și output;
- process-tree ownership și terminare verificabilă;
- servicii și baze de date dispensabile;
- identificarea imaginii/backendului și digestul profilului în evidence.

Backendul poate fi container, VM, sandbox nativ demonstrabil sau runner remote cu proprietăți echivalente. Numele tehnologiei nu este contractul; capability report-ul este contractul.

### Profilul `trusted-local`

Este permis numai când:

- repository-ul este declarat controlat de utilizator;
- grantul îl permite explicit;
- env allowlist, limita de output și timeout-ul procesului copil direct rămân active;
- raportul final marchează clar că nu a existat izolare completă față de host.

Nu poate fi selectat implicit numai pentru că un worktree este curat.
Implementarea locală curentă nu probează și nu raportează anularea întregului process
tree, limite CPU/memorie/procese, restricții de filesystem sau blocarea rețelei.

### Separarea control-plane/data-plane

Motorul trebuie să comunice cu providerul AI, dar această necesitate nu acordă rețea comenzilor lansate din repository. Adapterul și procesul de tool execution folosesc politici distincte. Dacă backendul ales nu poate separa cele două suprafețe, rularea se blochează sau folosește un egress proxy allowlisted și auditat.

### Aplicare

Prin `ExecutionEnvironment` trec:

- Codex/Claude writer, compiler și reviewer;
- task gates și global gates;
- hooks Git;
- install/build/test/generate;
- servicii temporare și migrații de test.

Un hook nu este considerat sigur doar pentru că este versionat în repository.

## Consecințe

- Faza 0 trebuie să definească capability reports și un fake backend.
- Ținta pentru pilotul izolat rămâne un backend `isolated` probat; distribuția curentă
  eșuează închis până când acel backend există.
- Compatibilitatea Windows/Linux se testează pe proprietăți, nu pe presupuneri despre containere.
- `BLOCKED/ENVIRONMENT_UNAVAILABLE` este rezultatul corect când profilul autorizat nu poate fi satisfăcut.

## Alternative respinse

- Numai worktree și diff verification: nu limitează efectele proceselor.
- Numai sandboxul motorului: nu acoperă procesele lansate direct de worker.
- Network allow global pentru că motorul are nevoie de API: amestecă planul de control cu procesele repository-ului.

## Acceptance tests

1. Un proces nu poate citi un secret fixture din afara mount-urilor.
2. Un gate nu poate scrie în checkout-ul principal sau în profilul utilizatorului.
3. Accesul de rețea al unui test este blocat, dar adaptorul poate contacta providerul simulat.
4. Un process tree este terminat integral la timeout și cancel.
5. Limitele de output și procese produc evenimente și rezultat determinist.
6. Un backend fără capabilitățile profilului fail-close înainte de writer.
7. Evidence conține backendul, versiunea și digestul profilului, fără secrete.
