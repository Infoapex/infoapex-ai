# Module provenance and synchronization

The executable source of each reusable module is its standalone repository on
the `Infoapex` GitHub organization. This repository contains a tested, vendored
release projection so it can be installed without private runtime downloads.

The machine-readable pins are in `modules/provenance.json`. A `published` pin is a
full commit SHA on the standalone `main` branch. A new local module may be recorded
only as `local-candidate-unpublished`, with `sourceCommit: null` and a non-empty
`publicationGate`; it is not a release pin and must never be presented as published.
A bundle update to a published module must follow this order:

1. implement and test the change in the standalone module;
2. merge the standalone feature branch into `main` and publish that commit;
3. project the pinned source into `modules/<name>`;
4. apply only the adaptations declared in `allowedAdaptations`;
5. run `npm run check:provenance` and all release gates;
6. update the pin and commit the bundle projection atomically.

Bundle-local schema URNs, generic consumer wording and relative integration
paths are packaging adaptations. They must not change runtime semantics. Active
scope manifests are repository-specific governance state and are not copied
between repositories.

`ai-code-review` and `ai-code-docs` are pinned the same way as the other three
modules. The five published canonical modules — `ai-code-control`, `ai-code-worker`,
`ai-code-planner`, `ai-code-review`, `ai-code-docs` — are required by
`npm run check:provenance`.

## Local candidate exception

`ai-code-benchmark` is the sixth required bundle module. Its current record is
explicitly `local-candidate-unpublished`, so its `sourceCommit` is `null` rather
than an invented public SHA. The required external gate is to commit, test, merge,
and publish `Infoapex/ai-code-benchmark` on `main`, then replace the null value with
the resulting public 40-character SHA before a release.
