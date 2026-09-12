# P6 release-candidate audit

Run `node scripts/rc-audit.mjs` after `npm run build`. The audit checks the committed
documentation and governance artifacts, verifies that the npm dry-run excludes local
state, and confirms that the pilot remains `NOT_STARTED` until real evidence exists.

The expected local result is `INCONCLUSIVE` with code
`RC_LOCAL_AUDIT_PASS_EXTERNAL_EVIDENCE_MISSING`. This means all deterministic local
checks passed; it is not a production approval. The audit never creates a tag, pushes,
deploys, uploads, or publishes.

The candidate is still `0.1.0` pre-release. A `v1.0.0-rc.1` or `v1.0.0` requires a clean
commit, reproducible artifact, checksum, provenance, SBOM, signed owner decisions, and
the external evidence listed in `validation/p6/evidence-index.json`.
