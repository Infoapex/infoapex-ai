# R1 fail-closed canary incident

Experiment `p5-otel-candidate-r1-20260904` (hash
`9a0067b7b165180c45e3ef593f4b61822af155ab03e1566fccdf1de5535e806f`)
stopped after its first two-observation pair. Both observations and hidden oracles
passed, but trace evidence was null, so the preregistered stop policy prohibited
the remaining 18 calls.

The cause was a benchmark evidence-location mismatch. The worker compile path uses
its platform-default state layout even when the public project configuration
contains a separate state root. The evidence collector trusted only the configured
root. The correction accepts either the configured root or the exact public
platform layout `<state-base>/ai-code-worker/repos/<16hex>/runs/<run-id>`, while
still rejecting symlinks, junctions, traversal, arbitrary roots, and malformed
identifiers. Tests cover both layouts.

R1 was not resumed or rewritten. R2 used a new experiment ID, experiment hash,
state root, and independently signed authorization.
