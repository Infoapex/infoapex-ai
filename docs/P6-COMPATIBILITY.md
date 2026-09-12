# P6 core-local compatibility promise

This document is the release support contract. A combination is supported only when it is listed below and its no-retry CI matrix cell is green. All other combinations fail closed; passing a local command outside this matrix is not a support commitment.

## Supported matrix

| Boundary | Minimum | Recommended | Supported / pinned value |
| --- | --- | --- | --- |
| Operating system | Windows Server 2022, Ubuntu 22.04, macOS 13 | Current GitHub-hosted Windows, Ubuntu, and macOS images | `win32`, `linux`, `darwin` |
| Node.js | 22.x | 24.x | exactly major 22 or 24 |
| .NET control component | 9 SDK | latest 9 SDK patch | `9.x` |
| Core-local provider | built-in hermetic fake provider | built-in hermetic fake provider | `fake@1.0.0` |
| Contract envelopes and handoffs | schema 1.0 | schema 1.0 | same-major `1.0` |

The package and ZIP smoke paths invoke the generated runtime entry points, not TypeScript source. The ZIP is created with `git archive` at the release commit; smoke verifies its SHA-256 sidecar and manifest before extracting it. The npm smoke creates a tarball, installs it in a fresh directory, and starts its installed root and delegated entry points with npm offline mode enabled.

## Provider policy

`fake@1.0.0` is the sole pinned provider in the core-local promise and is capability-probed before CI work starts. It does not use credentials, a vendor binary, or the network. Codex CLI and Claude Code remain optional integrations: their versions, authentication, models, and provider protocols are outside this core-local compatibility guarantee. They are rejected by the checker rather than silently falling back to `fake`.

Run the deterministic gate locally:

```text
node scripts/compatibility-check.mjs --provider fake --provider-version 1.0.0 --require-provider-capability
```

The checker emits one JSON document with `schemaVersion`, `status`, `code`, observed values, the immutable support table, and ordered diagnostics. Unsupported platform, Node major, provider, or provider version exits 2 with `COMPATIBILITY_UNSUPPORTED`; scripts must treat that result as terminal before invoking a provider.

## Regression policy

Compatibility is protected by explicit boundary tests, not a global coverage percentage. Every compatibility defect receives a deterministic regression test for the affected contract, path, quoting, event/JSON parsing, provider version, or package boundary. CI runs every OS × Node matrix cell without retry or `continue-on-error`. A flaky test is a failure to repair, not a reason to retry a release gate.

Dependencies are bootstrapped with `npm ci --ignore-scripts` before local verification. `node_modules` is ignored runtime-only content and must never be committed. The required verification sequence is root tests, generic-boundary, package-content check, package smoke, then the artifact smoke in CI/release.
