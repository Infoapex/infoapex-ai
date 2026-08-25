# Infoapex AI

`infoapex-ai` is the redistributable bundle for the Infoapex AI coding tools.
It contains the installer and all modules in one repository. The installed
agents remain local CLI providers; no provider credentials are stored here.

## Modules

- `ai-code-planner` creates scoped, linted implementation plans.
- `ai-code-worker` compiles, freezes and executes plans with gates and evidence.
- `ai-code-review` performs read-only milestone and repository reviews.
- `ai-code-docs` generates verified project documentation through the planner, worker and review contracts.
- `ai-code-control` provides optional code context, memory and scope analysis.

The modules communicate only through files, CLI-JSON and versioned schemas. They
do not import one another's source code.

## Modes

```text
ai-code-apex init --repo <path> --mode independent
ai-code-apex init --repo <path> --mode integrated
```

`independent` is the default. Planner and worker remain usable on their own.
`integrated` enables the shared `.ai-code-apex/runs` handoff directory. Planner
publishes an accepted plan and routing proposal; worker publishes execution
feedback; planner can consume that feedback and request a continuation.

The integration channel is advisory and bounded. A missing or invalid feedback
file never turns a standalone planner or worker invocation into a hidden
dependency.

## Development

```text
npm run setup
npm run build
npm test
npm run value-gate:internal
npm run review-gate:internal
npm run docs-gate:internal
```

`value-gate:internal` runs three generic planner-to-worker flows without
provider usage. `value-gate:live` is an explicit, usage-consuming validation for
the installed Claude CLI and should be run only when the provider account has
available quota.

The `modules/` entries are vendored module sources. The bundle has no Git
submodule or private-repository dependency at install time.

For a local project, run the installer from the bundle:

```text
node dist/src/cli.js init --repo <path> --mode independent
node dist/src/cli.js init --repo <path> --mode integrated
```

The repository can be distributed as a ZIP. Extract it, run `npm run setup`,
build the bundle, and use the same installer command against any target
project.
