# ADR-0005: Contractul root → plan → worker pentru proiecte noi

- **Status:** accepted with P5 pilot blockers tracked
- **Date:** 2026-09-05
- **Scope:** `ai-code-benchmark`, public root CLI, `ai-code-worker`, consumer repositories

## Context

Pilotul EuroCarScan a arătat că testele unitare pot fi verzi în timp ce integrarea
reală eșuează: workspace-ul era umflat de dependențe generate, root CLI nu returna
implicit JSON, `stateRoot` configurat era ignorat de unele componente, iar un proces
provider putea fi clasificat doar printr-un exit code generic. Acestea împiedică
aplicarea Infoapex-AI la un repository greenfield.

## Decizie

1. Orice apel benchmark către root folosește `run ... --json`; stdout este un singur
   envelope JSON, iar progresul merge pe stderr.
2. Envelope-ul public trebuie să păstreze cel puțin `status`, `runId`,
   `compile.status`, `findings[].code` și un mesaj redacted. Adapterul nu persistă
   stdout/stderr brut.
3. `stateRoot` este rezolvat din configurația repository-ului și este folosit
   identic la compile, run, status, checkpoint, worktree și telemetry. Starea trebuie
   să fie externă repository-ului.
4. Workspace-ul benchmark copiază doar sursa evaluată; dependențele generate și
   cache-urile sunt excluse determinist.
5. Fiecare experiment începe cu un canary de o observație. Timeout, exit non-zero,
   envelope malformed sau evidence incomplet opresc matricea și produc
   `INCONCLUSIVE`, nu acceptare automată.
6. Modelul, efortul și sandbox-ul se citesc exclusiv din armul experimentului
   înghețat; modelul conversației nu este moștenit implicit.

## Consecințe

Integrarea devine inspectabilă și reproductibilă, iar erorile de infrastructură nu
sunt confundate cu performanța modelului. Un consumator poate rula fără provider
activ (`contextProvider: none`), iar activarea control-plane sau a unui provider
real rămâne explicită și autorizată.

## Testare obligatorie

- test fake pentru root care eșuează dacă lipsește `--json`;
- test compile/status/checkpoint cu `stateRoot` configurat;
- test de plan acceptat care păstrează promptul și criteriile byte-identic;
- test de canary care oprește matricea la prima anomalie;
- test negativ pentru workspace traversal, directoare generate și envelope fără
  finding public.

