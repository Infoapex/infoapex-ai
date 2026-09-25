# Task - 2026-09-24 - IA-RUST-01 Rust structural impact indexing

## Goal
Implement IA-RUST-01: syntax-aware Rust structural impact indexing without changing CopyBot application code.

## Context used
- Infoapex AI AGENTS.md, task-specific memory brief, existing Rust indexer and SQLite graph contracts.
- Multi-crate CopyBot pilot for ReadyBatch and EvidenceRepository.

## Changed files
- .ai-code-control/reports/refactor/current-plan.json (modified)
- modules/ai-code-control/tools/ai-code-control/README.md (modified)
- modules/ai-code-control/tools/ai-code-control/src/AiCodeControl.RustIndexer/AiCodeControl.RustIndexer.csproj (modified)
- modules/ai-code-control/tools/ai-code-control/src/AiCodeControl.RustIndexer/Models/RustIndexModels.cs (modified)
- modules/ai-code-control/tools/ai-code-control/src/AiCodeControl.RustIndexer/Services/RustIndexerService.cs (modified)
- modules/ai-code-control/tools/ai-code-control/src/AiCodeControl.RustIndexer/Services/RustReferenceResolver.cs (added)
- modules/ai-code-control/tools/ai-code-control/src/AiCodeControl.RustIndexer/Services/RustSyntaxParser.cs (added)
- modules/ai-code-control/tools/ai-code-control/tests/AiCodeControl.Tests/AiCodeControl.Tests.csproj (modified)
- modules/ai-code-control/tools/ai-code-control/tests/AiCodeControl.Tests/RustIndexerTests.cs (added)

## Changes made
- Replaced line-regex Rust parsing with TreeSitter.DotNet syntax traversal.
- Added crate-aware import, type, trait, impl, and call relationships; unresolved tokens remain explicit.
- Added multi-crate tests for structural impact, ambiguity, replay, and deletion pruning.
- Documented syntax-only resolution limits and retained CLI commands.

## Validation
- dotnet restore/build/test AiCodeControl.sln: PASS (117 tests).
- dotnet list AiCodeControl.sln package --vulnerable --include-transitive: no vulnerable packages.
- npm test: PASS (81 tests).
- verify-changed-files: PASS on ia-rust-01 branch.
- run-validation: PASS status, with configured toolchains skipped; explicit commands above supplied validation.
- CopyBot index: 10 files, 304 symbols, 527 edges. ReadyBatch: 13 direct, 15 transitive, 6 files. EvidenceRepository: 11 direct, 12 transitive, 4 files.

## Open issues
- Syntax-only resolution does not infer arbitrary method receiver types, expand macros/glob imports, or perform rust-analyzer semantic resolution.

## Next recommended task
None in this scope. IA-RUST-01 is complete; ai-code-worker and CopyBot CB-004 were not changed.
