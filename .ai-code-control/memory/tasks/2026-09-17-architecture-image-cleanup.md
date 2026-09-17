# Architecture image cleanup

Date: 2026-09-17
Review: authoring agent visually inspected the generated image; no independent review claimed.

- Updated only the Romanian current-architecture control-flow PNG.
- Removed the red warning banner and the duplicate planner-to-control branch.
- Added module ownership labels for planner, worker, review, docs and benchmark.
- Built-in imagegen edit prompt: preserve the original infographic; remove the red banner; keep one planner-to-control arrow; place module labels above their card groups.
- Visual inspection confirmed all three requested changes and retained the other connectors.
- git diff --check passed. run-validation skipped because no toolchains are enabled; no runtime tests claimed.
- No existing code changed, so symbol lookup and impact analysis were not applicable. No trace source manifest is declared; no release was performed.
- Refreshed memory and code indexes scoped to docs/assets. Pre-existing untracked files were left untouched.
