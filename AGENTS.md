# Agent guide

Versioned Markdown, ADRs, contracts and migrations are canonical. SQLite databases are rebuildable caches.

Before editing, run `memory-health`, generate a task-specific `memory-brief`, activate a scoped task manifest, and use `find-symbol` plus `impact-analysis` for existing code.

Use memory search for text discovery, the code graph for symbol lookup and blast radius, and bounded trace queries for declared why, current, affected, and evidence relationships. Never treat a fallback as equivalent evidence.

Use `graph-drift --fail-on-review` as a release gate after the project has declared and ingested its trace sources.

After editing, run validation, verify changed files, refresh memory/code indexes and write a reviewed task summary. Never persist secrets, personal data or raw conversations.