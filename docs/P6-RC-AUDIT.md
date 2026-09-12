# P6 release-candidate audit

Run `node scripts/rc-audit.mjs` after `npm run build`. The audit checks the committed
documentation and governance artifacts, verifies that the npm dry-run excludes local
state, and confirms that the pilot remains `NOT_STARTED` until real evidence exists.

The expected local result is `INCONCLUSIVE` with code
`RC_LOCAL_AUDIT_PASS_EXTERNAL_EVIDENCE_MISSING`. This means all deterministic local
checks passed; it is not a production approval. The audit never creates a tag, pushes,
deploys, uploads, or publishes.

The default audit is the strict multi-consumer/enterprise profile. For the solo
maintainer release track, run `node scripts/solo-release-audit.mjs`: it produces an
internal candidate only after the local test, rollback, package, provenance, SBOM and
clean-install gates pass. It does not create a tag or publish anything.

The solo profile does not require the 3-repository/2-team/30-day pilot or an independent
audit before an internal RC or first public release. Those are recommended post-release
evidence for a solo project and remain mandatory for enterprise adoption claims. A
maintainer Go/No-Go, protected tag and public release workflow are still required before
publication. The candidate stays pre-release until that decision is made.
