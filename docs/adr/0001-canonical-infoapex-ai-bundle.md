# ADR-0001: Canonical Infoapex AI bundle

- Status: accepted
- Date: 2026-08-30

## Context

`infoapex-ai` and the earlier `ai-code-apex` repository overlap as umbrella
projects. Maintaining two writable integration lines makes releases and module
pins ambiguous. The reusable modules also need one explicit path from standalone
source to the installable bundle.

## Decision

`infoapex-ai` is the sole canonical umbrella, integration and release repository.
Standalone module repositories remain canonical for their own executable source,
and `modules/provenance.json` pins the exact commits projected into this bundle.

`ai-code-apex` becomes a read-only compatibility predecessor. It may retain
historical documentation and links, but it must not receive new runtime features,
module pins or releases. Consumers migrate to `infoapex-ai`.

## Consequences

- New cross-module work lands in standalone modules first and in this bundle
  second.
- Bundle-only runtime fixes are not accepted; urgent fixes must be backported to
  the owning standalone module before release.
- Repository archival in the hosting service is an administrative follow-up;
  the compatibility status is already binding for development.
