# GitHub README splash display

Date: 2026-09-18
Review: author reviewed the scoped diff and asset integrity; no independent review claimed.

- The current architecture PNG was already tracked on origin/main. Public raw delivery returned HTTP 200, image/png, 1581517 bytes; Pillow verified PNG integrity and 1672 x 941 dimensions.
- Replaced percentage HTML width with intrinsic numeric width, retaining GitHub max-width responsiveness; added an explicit full-resolution image link.
- The reported missing display could not be reproduced through HTTP; this is a rendering robustness change, not a missing-file repair.
- Validation: git diff --check passed. run-validation reported pass with all toolchains skipped (none enabled). No application code changed, so symbol impact analysis is not applicable.
- Bounded README trace returned not_found, empty sources, no fallback. Trace ingestion is not configured; the conditional graph-drift release gate does not apply.
- Existing UI work and untracked illustration variants are excluded from this commit.

## Inline image follow-up

- Replaced the HTML wrapper and separate textual link with a standard Markdown image at the beginning of README, as requested.
- Author reviewed the diff; no application code or image content changed. Symbol impact analysis remains inapplicable.
