# Worker Onboarding

`ai-code-worker` is distributed as part of the Infoapex AI bundle. The bundle
owns the worker source and its version, while the target project receives only
the worker configuration and state directories created by the CLI.

## First install

From the bundle root:

```powershell
npm ci --prefix modules/ai-code-worker
npm run build --prefix modules/ai-code-worker
node modules/ai-code-worker/dist/src/cli.js init --engines codex,claude
```

`init` creates `.ai-code-worker/config.json`, the local README and optional
engine shim files. It never stores provider credentials. Run the doctor command
before a real task:

```powershell
node modules/ai-code-worker/dist/src/cli.js doctor --engine all
```

For a Claude writer, the default `dontAsk` mode remains fail-closed. A trusted
local override is available only when the surrounding process is already
externally sandboxed:

```powershell
node modules/ai-code-worker/dist/src/cli.js doctor --engine claude `
  --claude-permission-mode bypassPermissions `
  --claude-dangerously-skip-permissions --json

node modules/ai-code-worker/dist/src/cli.js run --engine claude `
  --claude-permission-mode bypassPermissions `
  --claude-dangerously-skip-permissions --repo . --plan Plan/TASK.md --json
```

The worker still enforces worktree scope, commit validation, quality gates and
the selected execution profile. Provider-side permission failures can be
classified as availability failures when a second routing candidate exists.

## Updating the bundle

Update the bundle as one versioned unit, reinstall dependencies, and run the
worker's additive config update:

```powershell
npm ci --prefix modules/ai-code-worker
npm run build --prefix modules/ai-code-worker
node modules/ai-code-worker/dist/src/cli.js update
```

The command preserves existing project choices and only adds missing top-level
configuration keys. Operational state remains outside the repository according
to `stateRoot`; updating the bundle does not rewrite task history.

## Optional engine shims

`init --install-shims` adds the versioned Codex and Claude invocation shims to
the target project. They are convenience entry points only: they hold no run
state and grant no capability the provider CLI does not already have.
