# Datasets

`generic-v1` is the distributable deterministic suite: exactly twelve useful fixture
tasks covering every required benchmark category. Tasks contain an evaluator-only
`oracleRef`, never the reference solution, expected diff, or oracle payload. Oracle
material must be mounted only in the evaluator environment after an arm completes.

The loader accepts only JSON paths contained beneath the suite directory and rejects
absolute paths, traversal, missing files, duplicate task IDs, and mismatched frozen
experiment IDs/hashes.
