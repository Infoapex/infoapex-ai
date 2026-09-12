# P6 consumer pilot protocol

Pilotul consumator este un experiment separat de testele deterministe ale bundle-ului.
Preregistrarea din `validation/p6/pilot-preregistration.json` îngheață protocolul înainte
de prima rulare. În lipsa datelor reale, verdictul rămâne `NOT_STARTED` sau
`INCONCLUSIVE`; nu se completează retroactiv cu fixtures Infoapex.

## Protocol înghețat

- minimum 3 repository-uri consumatoare care nu sunt fixtures Infoapex;
- minimum 2 utilizatori sau echipe independente de implementator;
- 60 de taskuri reale bounded cumulate, dintre care minimum 20 paired pentru valoare;
- minimum 30 de zile între primul și ultimul checkpoint;
- minimum un upgrade, rollback pe state real sanitizat, incident drill și restore test;
- feedback structurat despre onboarding, erori și intervenții manuale.

Pragurile sunt: minimum 90% taskuri valide finalizate sau respinse corect, 100% scope
checks, zero scope escapes/secret leaks/incidente critice, cel mult 20% intervenții
manuale neplanificate, 100% upgrade/rollback/restore și minimum 80% quickstart fără
ajutor direct.

## Stop conditions și confidențialitate

Oprește pilotul la primul scope escape, secret leak, recovery distructiv, încălcare a
politicii sau finding critic. Nu se colectează conversații brute, credențiale sau output
de provider. Evidența se sanitizează local și se transferă numai printr-un canal aprobat.

Raportul final trebuie să includă sample size, excluderi prestabilite, toate failure-urile,
intervențiile, upgrade/rollback/restore evidence, incidentele și verdictul `PASS`, `REJECT`
sau `INCONCLUSIVE`. Un pilot sub prag nu poate fi reparat prin eliminarea post-hoc a
taskurilor.
