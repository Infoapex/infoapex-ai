# EuroCarScan — plan de execuție P5

## Regula de model și efort

Modelul și efortul nu se aleg automat din promptul conversației. Pentru un run
reproductibil, ele sunt câmpuri înghețate în `suite.json` și `experiment.json`,
iar runner-ul le transmite identic către brațul direct și către worker. Modelul
acestui prompt (`gpt-5.6-luna`, high) controlează doar sesiunea curentă Codex; nu
schimbă un experiment P5.

Recomandarea de proiect este:

| Subproiect | Implementare | Review/gate | Motiv |
|---|---|---|---|
| OpenTelemetry redactat | `gpt-5.6-terra`, high | `gpt-5.6-sol`, high | implementare standard, dar cu risc de leakage |
| Codex/Claude SDK adapters | `gpt-5.6-sol`, high | `gpt-5.6-sol`, high | boundary și recovery semantics |
| UI local read-only | `gpt-5.6-terra`, high | `gpt-5.6-sol`, high | contracte deja stabilizate |
| provider registry | `gpt-5.6-terra`, high | `gpt-5.6-sol`, high | contract și compatibilitate |

Pentru comparații, schimbarea modelului sau efortului creează un braț nou și un
experiment nou; nu se modifică baseline-ul existent.

## Gate înainte de orice consum live

1. `npm test` în Infoapex, `dotnet test` în EuroCarScan și `npm run typecheck`
   pentru frontend.
2. `doctor` pentru Codex și Claude, cu versiuni și sandbox explicit.
3. Test fake planner → worker → evaluator, inclusiv final JSON structurat,
   commit și cleanup.
4. Smoke Codex direct, o singură observație, apoi smoke worker/full-ICM, o
   singură observație. Se verifică `DONE`, diff în scope și zero cache înregistrat.
5. Smoke Claude separat, fără a-l amesteca în comparația Codex.
6. Canar P5 de două observații pereche. Oprim imediat la exit code 2, output
   nestructurat, scope violation, leakage, fallback sau proiecție de quota ≥95%.
7. Doar după canar valid se autorizează restul matricei de 30 observații pentru
   suite-ul consumator C#.

## Artefacte obligatorii

Fiecare candidat P5 păstrează ADR, threat model, contract versionat, ipoteză,
experiment hash, autorizare explicită, teste negative, raport redacted și
dovada de non-regresie pentru modulele standalone. Lipsa unei dovezi produce
`INCONCLUSIVE`, nu succes implicit.
