# P5 baseline register v1

Status: **NOT_ESTABLISHED**.

The only completed BENCH-P campaign, `bench-09-pilot-codex`, executed and evaluated
all 30 authorized observations, but its immutable final verdict is **REJECT**. Four
critical scope findings are classified as a benchmark timeout/cleanup infrastructure
race, not as behavior attributable to an evaluated arm. The scheduler remediation is
covered by a regression test, but it does not rewrite, upgrade, or erase the rejected
experiment.

The authorized next action is a fresh BENCH-P rerun: it needs a new experiment ID, a
new authorization, and a post-fix frozen configuration. It must retain the original
result and meet the 90% valid-observation, zero-critical-safety, frozen-input, and
independent-evaluation gates before it can populate this register's authoritative
baseline fields.

The machine-readable status and identifiers are in `P5-BASELINE.v1.json`. Every P5
candidate must use the mandatory
`modules/ai-code-benchmark/templates/candidate-hypothesis.template.json` before the
first candidate invocation.
