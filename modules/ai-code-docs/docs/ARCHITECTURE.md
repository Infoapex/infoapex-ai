# ai-code-docs architecture

```text
docs request
  -> planner inspect / compile
  -> control health + memory brief
  -> worker run (isolated documentation writer)
  -> review run (read-only verification)
  -> versioned docs report
```

The module communicates with its neighbors only through CLI arguments, JSON and
versioned schemas. The worker remains the only component that invokes a writing
provider. A failed prerequisite is visible and produces `BLOCKED`; no partial
generation is reported as `DONE`.
