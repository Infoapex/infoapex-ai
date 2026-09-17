# Current architecture and planned Docker isolation

Date: 2026-09-17
Task: ARCHITECTURE-DIAGRAMS-20260917
Source baseline: 4a35fbc
Review: authoring agent inspected source contracts and rendered diagrams; no independent audit claimed.

## Changes

- README now contains colored Mermaid overviews for the current trusted-host profile and the planned container topology.
- docs/ARCHITECTURE.md explains module ownership, CLI/JSON interactions, state locations, context, evidence, execution and Docker boundaries in Romanian, with two sequence diagrams.
- Explicitly distinguishes existing Docker backend code from the unqualified RC-00 through RC-08 target.
- Corrected blanket README claims about cheapest-model routing and optional control; added benchmark to the module table and repository tree.
- Diagrams explain scoped egress, separate credential-free validation, temporary test services, controlled result application and cleanup/recovery limits.

## Validation

- Four diagrams rendered with Mermaid CLI 11.17.0 and visually inspected; sequence syntax corrected before final render.
- All 41 local Markdown file links and anchors checked; code fences balanced.
- git diff --check passed.
- run-validation had no enabled toolchains and skipped execution; this is not runtime test evidence.
- graph-drift --fail-on-review returned REVIEW_REQUIRED: empty trace graph and no declared source manifest. No fallback was treated as trace evidence.
- Scope restricted to README, architecture guide, task manifest and this summary. Runtime/module code is unchanged.

## Limits

- Documentation only; no Docker provisioning, live provider calls, release qualification, commit or push performed by this task.
- The diagrams derive from the cited source files and approved backlog; they do not mark pending RC work complete.
