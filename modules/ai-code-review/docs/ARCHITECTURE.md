# ai-code-review architecture

## Flow

```text
review request
  -> planner inspect / plan
  -> control health + memory brief + impact analysis
  -> worker review (read-only provider invocation)
  -> schema validation and normalized report
```

The planner and control calls are advisory inputs, but their failure is visible. A review
cannot be reported as `PASS` if a configured prerequisite is blocked. The worker is the
only component allowed to invoke Claude or Codex, so review uses the same provider
compatibility, timeout, output and read-only policy as execution.

## Isolation

Review receives a base commit and head commit. It reads the resulting diff and acceptance
criteria. It does not edit files, create commits, run repair cycles or change the target
repository. Findings are evidence, not instructions for an automatic write operation.

## Verdicts

- `PASS`: planner/control/worker completed and the reviewer found no blocking or major issue.
- `FAIL`: the review completed and reported a blocking or major finding.
- `BLOCKED`: a prerequisite, provider, schema or control step failed; no quality verdict is claimed.
