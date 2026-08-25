# Onboarding

The review module is shipped inside the Infoapex AI bundle. Install the bundle
dependencies once, then invoke the bundled CLI:

```powershell
npm ci --prefix modules/ai-code-review
npm run build --prefix modules/ai-code-review
node modules/ai-code-review/dist/src/cli.js init --repo .
```

Edit `.ai-code-review/config.json` when the planner, worker or control commands are
not at their default project-relative paths. Keep the worker command pointed at the
version pinned for the project; review is a consumer of the worker contract, not a
source-level dependency.
