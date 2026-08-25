# AICW-ADR-005: Protocol streaming pentru adaptoarele de motor

- Status: acceptat
- Data: 2026-08-01
- Owner: developer experience
- Plan asociat: [planul de implementare v1.2](../IMPLEMENTATION-PLAN.md)

## Context

Un API care returnează numai rezultatul final nu poate furniza la timp session ID-ul, heartbeat-ul, progresul, usage-ul raportat, output limits sau o anulare observabilă. Atât adaptoarele CLI, cât și viitoarele adaptoare SDK produc evenimente care trebuie normalizate fără a introduce tipuri specifice providerului în core.

## Decizie

Interfața comună devine:

```ts
interface EngineAdapter {
  doctor(): Promise<CapabilityReport>;
  start(request: AgentRequest): Promise<ExecutionHandle>;
  resume(request: ResumeRequest): Promise<ExecutionHandle>;
  cancel(handle: ExecutionHandle, reason: string): Promise<CancelResult>;
}

interface ExecutionHandle {
  executionId: string;
  sessionId?: string;
  events: AsyncIterable<EngineEvent>;
  completed: Promise<AgentExecutionResult>;
}
```

### Evenimente normalizate

Fiecare eveniment conține:

- `schemaVersion`, `executionId`, `sequence`, `createdAt`;
- `type` comun;
- `sessionId` când este cunoscut;
- payload normalizat și limitat;
- `rawPayloadSha256` opțional pentru audit;
- usage parțial numai când motorul îl raportează.

Tipurile minime sunt `execution.started`, `session.bound`, `progress`, `command.started`, `command.finished`, `file.changed`, `usage.reported`, `heartbeat`, `warning`, `execution.completed`, `execution.failed` și `execution.cancelled`.

Sequence este monoton per execution. Duplicatele sunt ignorate prin `(executionId, sequence)`. Un gap produce warning și poate bloca rezultatul dacă evenimentul lipsă este necesar pentru audit.

### Lifecycle

- Consumarea fluxului începe imediat după `start`.
- `session.bound` este persistat înaintea oricărui eveniment ulterior care îl folosește.
- `completed` se rezolvă o singură dată după terminal event și închiderea controlată a streamului.
- Heartbeat-ul procesului dovedește că procesul trăiește; nu dovedește progres semantic.
- Inactivity timeout folosește o politică explicită și nu poate fi ținut artificial activ numai prin output nelimitat.
- Backpressure, output cap și redaction se aplică înaintea persistenței.

### Usage și bugete

Worker-ul verifică bugetele după fiecare `usage.reported` și înaintea unei invocări noi. Nu pretinde oprire exactă între două raportări ale providerului. Câmpurile necunoscute rămân `null`; payloadul providerului nu este reinterpretat ca zero.

### Resume

Se disting:

- reluarea unei sesiuni a motorului prin `sessionId`;
- recuperarea procesului/coordinatorului worker;
- o invocare nouă în același task attempt.

Adapterul nu afirmă că se poate reatașa la un proces mort. El pornește o nouă execuție de resume numai după ce core-ul a reconciliat starea și authorization binding-ul.

## Consecințe

- Contract tests trebuie să acopere ordinea, duplicatele, gap-urile, truncarea și anularea.
- Adaptoarele pot folosi CLI JSONL acum și SDK ulterior fără schimbarea core-ului.
- Session ID-ul și usage-ul devin dovezi timpurii, nu numai câmpuri în rezultatul final.

## Alternative respinse

- `run(): Promise<Result>`: observabilitate și anulare insuficiente.
- Persistarea transcriptului brut: supraexpunere de date și contract instabil.
- Folosirea directă a tipurilor Codex/Claude în core: coupling de versiune.

## Acceptance tests

1. Session ID-ul este persistat imediat după evenimentul de bind.
2. Usage parțial actualizează bugetul fără a transforma necunoscutul în zero.
3. Output excesiv este limitat fără deadlock și produce evidence.
4. Cancel termină procesul și emite un singur rezultat terminal.
5. Duplicatele nu dublează usage-ul; un gap critic blochează auditul.
6. Același fake stream trece prin adapter CLI și adapter SDK fixture cu rezultat comun identic.
