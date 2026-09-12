# P6 core-local SLO contract

This is the measurement contract for the `core-local` profile. It is local evidence,
not a claim about a provider's service availability. Unknown or missing evidence is
never counted as success. Owners review the window at least weekly and after every
severity 1 or 2 incident.

```json
{
  "schemaVersion": "1.0",
  "source": ".infoapex-ai/telemetry/events.jsonl",
  "export": "off",
  "eventContract": {"allowedFields": ["schemaVersion", "type", "outcome", "occurredAt"], "rawTranscript": "forbidden"},
  "slos": [
    {"id":"terminal-completion","owner":"runtime","window":"rolling-30d","numerator":"terminalExplicit","denominator":"terminalObserved","target":"100%","missingEvidence":"BLOCKED"},
    {"id":"scope-leakage","owner":"security","window":"rolling-30d","numerator":"scopeEscapes + secretLeaks","denominator":"all completed runs","target":"0","missingEvidence":"BLOCKED"},
    {"id":"recovery","owner":"runtime","window":"rolling-30d","numerator":"recoverySucceeded","denominator":"recoveryAttempts","target":">=95%","missingEvidence":"UNKNOWN"},
    {"id":"latency","owner":"runtime","window":"rolling-30d","numerator":"latency events within approved budget","denominator":"eligible latency events","target":">=95%","missingEvidence":"UNKNOWN"},
    {"id":"usage","owner":"product","window":"rolling-30d","numerator":"usage events within approved run budget","denominator":"eligible usage events","target":"100%","missingEvidence":"UNKNOWN"},
    {"id":"human-intervention","owner":"operations","window":"rolling-30d","numerator":"runs without unplanned human_intervention","denominator":"completed runs","target":">=80%","missingEvidence":"UNKNOWN"}
  ]
}
```

`scope` and `leakage` events with outcome `DETECTED` increment the corresponding
zero-tolerance counters. A `terminal` event is compliant only when its outcome is
`DONE`, `BLOCKED`, or `CANCELLED`. Recovery is compliant only when a `recovery` event
has outcome `RECOVERED`. Latency and usage are recorded as eligibility/outcome events;
numeric provider payloads are intentionally excluded from telemetry and support bundles.

Alerts deduplicate by SLO id plus rolling window. Security owns immediate paging for a
scope escape or leak. Runtime owns terminal, recovery, and latency; Product owns usage;
Operations owns intervention. An SLO breach produces a bounded code and a local support
bundle only on an operator's explicit command.
