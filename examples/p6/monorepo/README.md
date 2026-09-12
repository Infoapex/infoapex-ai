# Monorepo consumer example

Configurează directoarele aplicației prin profilul `generic`, apoi tratează fiecare
package ca scope separat în planuri bounded. Verifică mai întâi:

```bash
node dist/src/cli.js init --repo . --mode integrated --full --profile generic
node dist/src/cli.js preflight --repo .
```

Un singur run nu trebuie să scrie în alte package-uri decât cele declarate în `allowedPaths`.
