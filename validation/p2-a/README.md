# P2-A live preflight

P2-A freezes two minimal provider smoke tasks before P2-B compares implementation
arms. The checked-in experiment fixes the P1 source baseline, task goals and hashes,
provider model selections, CLI versions, a maximum of two live invocations and
`graph06Enabled: false`.

The deterministic command consumes no provider usage:

```powershell
npm run p2:preflight
```

The live command is an explicit quota-consuming opt-in and writes no raw prompts or
provider output to the repository:

```powershell
node scripts/p2-live-preflight.mjs --live --json --out validation/p2-a/live-report.json
```

A functional PASS does not imply economic comparability. Codex currently reports no
cache-write count or USD cost, so its normalized usage is expected to remain partial
and the combined economic verdict remains `inconclusive`. P2-B must preserve that
distinction. Starting a nested Codex smoke also creates another rollout; development
session token/percentage calibration must therefore be closed before the live smoke
or reported as non-comparable. Codex CLI 0.147 does not expose token counts in the
worker's `exec --json` stdout even though its local rollout contains cumulative
`token_count` events. The preflight uses those events only as a bounded, read-only,
sanitized fallback and records `usageSource`; prompt and conversation text are never
copied into the report.
