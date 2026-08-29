# Trace query evaluation (GRAPH-03)

Status: local implementation gate passed on 2026-08-28

Profile: `codex:gpt-5.6-sol:high`

## Accuracy definition

The preregistered 25-question inventory from `GRAPH-QUERY-AUDIT.md` is evaluated on:

1. the request is sent to its declared authoritative route;
2. the expected entity or relation is present;
3. a versioned source location or trace evidence path is returned;
4. no result silently falls back to another route.

This is route/entity/evidence accuracy, not a claim that every human-readable response is
minimal. The stricter GRAPH-00 direct-completeness metric remains separate because FTS
and substring symbol lookup can still be verbose.

## Results

| Inventory | Route | Passed | Evidence |
|---|---|---:|---|
| F01-F10 | memory FTS | 10/10 | expected versioned memory source matched |
| C01-C05 | code graph symbol lookup | 5/5 | expected structural source file matched |
| C06-C10 | code graph impact | 5/5 | exact target returned `status=ok` with structural edges |
| T01 | trace | 1/1 | ADR references contract with direct evidence |
| T02 | evidence-for | 1/1 | criterion to gate to evidence |
| T03 | evidence-for | 1/1 | task to criterion to gate to pilot evidence |
| T04 | current | 1/1 | terminal ADR resolved through `supersedes` |
| T05 | trace | 1/1 | context package to selected source and task |
| **Total** | explicit hybrid router | **25/25 (100%)** | **25/25 source/evidence complete** |

The first 20 cases were rerun through the built CLI DLL against the refreshed module
indexes. End-to-end process p95 was 173 ms. The five trace gaps are deterministic
integration fixtures in `TraceGraphQueryServiceTests`; all five return T0/T1
provenance and every traversed edge contributes an evidence reference to its path.

The direct-completeness comparison is 19/25 (76%): the original 14 complete FTS/code
answers plus five now-complete trace answers. GRAPH-03 fixes the missing multi-hop route;
it intentionally does not alter FTS ranking or broad substring symbol output.

## Safety and latency gates

- Hard accepted caps: depth 10, 200 nodes, 500 edges.
- Default query budgets: depth 3, 50 nodes, 100 edges.
- Depth, node, and edge truncation return `status=partial` plus exact reasons.
- Cycles are detected with visited node and edge sets.
- T2 is excluded by default; opt-in output is advisory and non-authoritative.
- Exact identity wins; ambiguous simple symbols fail without first-match behavior.
- Commit mismatch returns `status=stale`; no match returns `not_found`; a wrong typed
  route returns `unsupported`.
- A warm 100-query local trace benchmark had p95 2.572 ms against the preregistered
  250 ms core-query threshold.
- The 13 GRAPH-03 service tests cover routing, the five preregistered trace questions,
  evidence completeness, ambiguity, staleness, T2 filtering, cycles, budgets, and p95.

## Routing conclusion

Memory FTS remains the route for plain text, and the structural code graph remains the
route for symbol lookup and blast radius. The trace graph is used only for declared
why/current/affected/evidence relationships. Obsidian remains a human projection and is
not queried by agents.
