# ADR-0002 - Rust indexer: cargo metadata + structural parser

**Status:** Proposed; not implemented
**Date:** 2026-04-30

## Context

We need crate/symbol/dependency indexing for the Rust workspace under `rust/crates/live-core`.

## Decision

Use `cargo metadata --format-version 1` as the authoritative source for workspace structure, crates, packages, targets, and dependencies.

For symbol extraction (structs, enums, traits, impl blocks, functions) use tree-sitter-rust or a structural parser invoked by the .NET indexer.

For semantic references (advanced call graph, lifetime analysis) use `rust-analyzer` as a future enhancement — not required for MVP.

The current `index-rust` command is a legacy regex/TOML compatibility indexer and
does not satisfy this decision. Treat its results as navigation hints only.
consumer project does not use Rust application code.

## Consequences

- `cargo metadata` is always available and correct for dependency/crate topology.
- Structural parsing covers most refactor decisions.
- `cargo check`, `cargo clippy`, `cargo test`, `cargo fmt` are the validation gates after any Rust change.
- Generics, lifetimes, trait bounds, and macros are HIGH risk by default.

## Related files

- `tools/ai-code-control/src/AiCodeControl.RustIndexer/`
- `.ai-code-control/config/code-control.json` (`rust.*`)
