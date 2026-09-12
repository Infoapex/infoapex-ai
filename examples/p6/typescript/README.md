# TypeScript consumer example

```bash
node dist/src/cli.js init --repo . --mode integrated --full --profile generic
node dist/src/cli.js preflight --repo .
```

Păstrează taskurile bounded în `Plan/`, rulează mai întâi `--engine fake`, apoi cere
autorizarea explicită pentru providerul live.
