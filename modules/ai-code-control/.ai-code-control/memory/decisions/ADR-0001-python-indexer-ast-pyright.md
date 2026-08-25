# ADR-0001 - Python indexer: ast + pyright

**Status:** Proposed; not implemented
**Date:** 2026-04-30

## Context

We need structural indexing and semantic validation for Python projects.

## Decision

Use Python `ast` for structural extraction (classes, functions, imports, call expressions, decorators) and `pyright` / `basedpyright` for type checking.

Do not rely on regex-based parsing for refactor decisions.

The current `index-python` command is a legacy regex-based compatibility indexer.
Its results may assist navigation but are not authoritative for refactor decisions
until this ADR is implemented. consumer project does not use Python application code.

## Consequences

- Structural indexing is fast, local, and requires no external service.
- Type checking catches regressions after refactor.
- Dynamic constructs (monkey patching, `getattr`, dynamic imports) cannot be indexed statically — mark them HIGH risk in impact analysis.
- `ruff` handles lint; `pytest` handles functional validation.

## Related files

- `tools/ai-code-control/src/AiCodeControl.PythonIndexer/`
- `.ai-code-control/config/code-control.json` (the `python` toolchain commands)
