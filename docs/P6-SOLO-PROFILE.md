# P6 solo-maintainer profile

The `solo-maintainer` profile is intended for a public project owned and operated by
one developer. It separates technical release readiness from multi-team adoption
research.

An internal RC is accepted when the committed tree passes the full local test suite,
P6 gates, upgrade/rollback tests, reproducible ZIP creation, checksum/provenance,
CycloneDX SBOM, and clean-install smoke testing:

```text
node scripts/solo-release-audit.mjs --candidate v1.0.0-rc.1-internal
```

The command never tags, pushes, deploys, publishes, uploads, or changes release-gate
statuses. Its result is `SOLO_INTERNAL_RC_READY` with `publicationAllowed: false`.
The maintainer must make an explicit Go/No-Go decision before any public release.

The 3-repository/2-team/30-day consumer pilot and independent audit are not blockers
for this profile's internal RC or first public release. They remain recommended after
release and become mandatory when the product claims enterprise or multi-consumer
adoption. The profile and its boundary are recorded in
`validation/p6/solo-release-policy.json`.
