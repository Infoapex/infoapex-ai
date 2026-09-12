# .NET consumer example

Pentru un repository .NET cu frontend opțional:

```bash
node dist/src/cli.js init --repo . --mode integrated --full \
  --profile dotnet-nextjs --backend-dir src/Api --frontend-dir web
node dist/src/cli.js preflight --repo .
```

Căile sunt repository-relative. Nu include secrete în planuri, loguri sau diagnostics.
