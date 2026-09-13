# AICW-ADR-013: Boundary-ul execuției providerului

- Status: acceptat
- Data: 2026-09-13
- Owner: developer experience
- Plan asociat: [AICW-ADR-002](0002-execution-environments.md)

## Context

`ExecutionEnvironment` izolează comenzile controlate de repository și gate-urile,
dar adaptoarele Codex și Claude nu erau încă lansate prin acel backend. Un raport
`supported` pentru gate-uri nu poate fi folosit ca dovadă că procesul providerului
este izolat: providerul execută promptul, tool-urile și procesele copilului.

## Decizie

Raportul de doctor separă cele două contracte:

- `supported` descrie capabilitățile pentru comenzi de repository;
- `providerSupported` descrie dacă CLI-ul providerului este executat în boundary-ul
  declarat;
- `providerWarnings` explică de ce această dovadă lipsește, fără a include secrete,
  prompturi sau output brut.

`LocalIsolatedExecutionEnvironment` nu satisface `providerSupported`, chiar dacă
aplică environment scrubbed, timeout, limite de output și process-tree cleanup.
`DockerExecutionEnvironment` nu satisface încă această capabilitate până când
adaptorul providerului nu este rutat efectiv în container și testat cu un egress
allowlisted separat. Un simplu `docker run` pentru gate-uri nu este suficient.

`FakeExecutionEnvironment` poate raporta capabilitatea numai pentru profilul explicit
`providerExecution.mode: "simulated"`; boundary-ul rămâne `simulated` și nu poate
trece gate-ul de release public.

Writer-ele Codex și Claude blochează înainte de doctorul sau pornirea providerului
când `providerSupported` este fals. Astfel, lipsa izolării nu poate fi confundată cu
un run valid.

## Consecințe

- profilurile instalate local pot continua să ruleze verificările fără provider;
- run-urile reale locale devin explicit `BLOCKED` până la provisionarea unui runner
  provider OS-isolated;
- release-ul public rămâne blocat până la dovada ambelor componente: backendul și
  execuția efectivă a providerului prin acel backend;
- runnerul containerizat, credential forwarding allowlisted și probele de
  anulare sunt implementate în `execution/environment.ts`;
- activarea producției mai cere provisionarea externă a imaginii providerului și
  a proxy-ului de egress intern, cu allowlist independent verificat. Procedura
  este documentată în `docs/PROVIDER-RUNNER-PROVISIONING.md`.
