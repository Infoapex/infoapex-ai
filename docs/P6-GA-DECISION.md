# P6 GA decision package

Current decision: `NO-GO` / `INCONCLUSIVE`.

Local implementation and deterministic tests are complete through P6.8. Promotion is
not allowed while any of these are missing:

- the preregistered consumer pilot (3 repositories, 2 independent users/teams, 60
  bounded tasks, 30-day window, upgrade/rollback, incident drill, restore test);
- independent security, recovery/migration, and supply-chain audit;
- signed product, security, and operations go/no-go;
- reproducible candidate artifact with checksum, provenance, SBOM, and protected release
  workflow.

Before GA, execute rollback against the RC, verify installation from the artifact by a
consumer who did not build it, record the first 30-day owner/runbook checkpoint, and
only then use the protected release workflow. No local command in this repository is
authorized to bypass those conditions.
