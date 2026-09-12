# P6 GA decision package

Current decision: `NO-GO` for publication; `PASS` may be reached for the solo internal-RC profile.

Local implementation and deterministic tests are complete through P6.8. For the
`solo-maintainer` profile, an internal RC is allowed after the local release audit and
artifact checks pass. Publication still requires an explicit maintainer decision,
protected tag, and the public release workflow.

The following remain required for the enterprise/multi-consumer profile:

- the preregistered consumer pilot (3 repositories, 2 independent users/teams, 60
  bounded tasks, 30-day window, upgrade/rollback, incident drill, restore test);
- independent security, recovery/migration, and supply-chain audit;
- signed product, security, and operations go/no-go;
- reproducible candidate artifact with checksum, provenance, SBOM, and protected release
  workflow.

For the solo profile, rollback is executed locally against the candidate artifact and
the first 30-day owner/runbook checkpoint is post-release monitoring. No local command
automatically publishes or bypasses the maintainer decision. Enterprise claims retain
the external pilot and independent-audit requirements above.
