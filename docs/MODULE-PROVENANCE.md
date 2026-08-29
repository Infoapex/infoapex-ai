# Module provenance and synchronization

The executable source of each reusable module is its standalone repository on
the `Infoapex` GitHub organization. This repository contains a tested, vendored
release projection so it can be installed without private runtime downloads.

The machine-readable pins are in `modules/provenance.json`. Every pin is a full
commit SHA on the standalone `main` branch. A bundle update must follow this
order:

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

For `ai-code-review` and `ai-code-docs`, standalone extraction and provenance
pins are part of P1. Until then their vendored implementations remain owned by
this repository and are not represented as standalone pins.
