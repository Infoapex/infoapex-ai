# P6 data classification

| Class | Examples | Storage/export rule |
|---|---|---|
| Public | schemas, release notes | may be committed and published |
| Internal | run IDs, timings, redacted findings | local by default; export only by policy |
| Sensitive | source excerpts, diffs, user paths | never in public evidence; redact or hash |
| Secret | credentials, tokens, private keys | never persist in plans, logs, telemetry, or diagnostics |

Raw conversations are not canonical memory and are disabled by default.
