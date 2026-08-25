# ADR-0009 - Generic config-driven toolchains replace per-language classes

**Status:** Accepted
**Date:** 2026-07-05

## Context

ValidationRunner originally had hardcoded `PythonConfig`/`RustConfig` classes and
dedicated `RunPythonAsync`/`RunRustAsync` methods. Supporting a new stack (dotnet,
node, anything else) required code changes in Core, which contradicts the goal of a
reusable template.

## Decision

`code-control.json` defines a generic list of toolchains; each toolchain is a name,
a working directory and an ordered list of commands with per-command timeouts:

```json
{
  "toolchains": [
    {
      "name": "dotnet",
      "enabled": true,
      "path": "api",
      "commands": [
        { "name": "build", "run": "dotnet build --nologo", "timeoutSeconds": 300 },
        { "name": "test", "run": "dotnet test --nologo --no-build", "timeoutSeconds": 600 }
      ]
    }
  ]
}
```

ValidationRunner iterates toolchains and shells out per command. On Windows, commands
run via `powershell -EncodedCommand` (no quoting/escaping pitfalls); on Unix via
`bash -lc` with escaping.

## Consequences

- Adding a language stack is a config edit, not a code change.
- Result names are `<toolchain>.<command>` (e.g. `dotnet.test`), statuses are
  pass/fail/timeout/skipped, and failed commands include captured output.
- The old `python.*`/`rust.*` config shape is no longer read; `init --template`
  generates the new shape.

## Related files

- `tools/ai-code-control/src/AiCodeControl.Core/Models/CodeControlConfig.cs`
- `tools/ai-code-control/src/AiCodeControl.Core/Services/ValidationRunner.cs`
- `tools/ai-code-control/src/AiCodeControl.Cli/InitTemplates.cs`
