# P6 support policy

The pre-release `core-local` profile supports Node.js 22 and .NET 9 on Windows,
Linux, and macOS through the declared CI matrix. Provider support is capability-tested
by `doctor`; an unavailable or unsupported version blocks before execution.

Configuration schema `1.0` is supported during the pre-release line. Breaking schema
or security-boundary changes require a major version; additive opt-in functionality is
minor; compatible fixes are patch releases. Deprecations require a migration path and
one supported minor release of notice.

Critical security and destructive-recovery defects block release. Provider outages are
external dependencies and receive actionable diagnostics, not availability promises.

Distribution is through GitHub Releases. Public release promotion is blocked while the
repository remains private; after publication, GitHub keyless Sigstore attestations bind
the ZIP and CycloneDX SBOM to the workflow, repository, and commit.
