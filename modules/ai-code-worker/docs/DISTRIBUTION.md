# Distribution

The worker is distributed as a vendored module inside the `infoapex-ai` bundle.
The bundle is the versioned delivery unit for the installer, planner, worker,
control, review and docs modules.

## Bundle layout

```text
infoapex-ai/
  modules/ai-code-apex/
  modules/ai-code-control/
  modules/ai-code-planner/
  modules/ai-code-worker/
  modules/ai-code-review/
  modules/ai-code-docs/
```

The worker keeps its schemas, templates and compiled output beside its source
inside that directory. No install step fetches another private repository.

## ZIP distribution

A release ZIP contains the bundle source, lockfiles and documentation. The
recipient extracts it, installs Node dependencies, and invokes the root Apex
installer against a target project. The archive must not contain credentials,
provider tokens, personal data, `node_modules`, generated databases or runtime
state.

```powershell
Expand-Archive infoapex-ai-0.1.0.zip -DestinationPath .\tools
Set-Location .\tools\infoapex-ai
npm run setup
npm run build
node dist/src/cli.js init --repo C:\work\target-project --mode independent
```

The target machine needs Node.js 22 or newer. The optional control runtime also
needs the .NET 9 runtime/toolchain used by its MCP server. Provider CLIs remain
separate local installations and are discovered by the worker.

## Release invariant

The bundle must pass the root boundary check, every module test and JSON
validation, the internal planner-to-worker/review/docs gates, and a clean ZIP
extraction smoke test before publication. The usage-consuming live provider
gate is tracked separately because it depends on external account availability.
