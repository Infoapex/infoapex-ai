# Mandatory P5 candidate hypothesis

Every P5 capability must add a copy of
`candidate-hypothesis.template.json` before the first candidate invocation. The
completed manifest is validated against
`schemas/candidate-hypothesis.schema.json` and is supplied to `report` or `compare`
with `--hypothesis`.

Replace every `REPLACE` value, freeze the suite and budget, and identify exactly one
candidate change. A manifest does not establish a baseline by itself: it requires a
fresh, authorized experiment, benchmark-owned evaluation, and an explicit verdict.
Retrospective candidates must state that preregistration occurred after the change;
they must not be represented as prospective proof.
