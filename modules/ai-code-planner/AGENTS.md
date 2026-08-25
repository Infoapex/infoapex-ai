# Agent guide

Versioned Markdown, ADRs, contracts and migrations are canonical. SQLite databases are rebuildable caches.

Before editing, run `memory-health`, generate a task-specific `memory-brief`, activate a scoped task manifest, and use `find-symbol` plus `impact-analysis` for existing code.

After editing, run validation, verify changed files, refresh memory/code indexes and write a reviewed task summary. Never persist secrets, personal data or raw conversations.