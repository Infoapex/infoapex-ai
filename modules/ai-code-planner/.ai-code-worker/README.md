# .ai-code-worker

This directory is managed by `ai-code-worker init`/`ai-code-worker update`.

- `config.json` - project-level configuration (engine defaults, context provider,
  parallelism, state root, sync-root policy). Keys you add or change here are
  preserved by `update`; only keys missing from your file are ever added.
- Run `ai-code-worker update` after upgrading ai-code-worker to pick up new
  default config keys without losing your customizations.
