# Infoapex AI TODO

- Run the bounded usage-consuming common ICM + Graph pilot on 10 real sequential tasks when provider quota is explicitly authorized; record accuracy, retries, uncached context, total tokens and explanation time. The deterministic internal pilot is PASS, but it cannot establish provider economics.
- Keep GRAPH-06 parallel reviewers disabled until the live sequential baseline above exists; run the preregistered A/B experiment only with separate authorization.
- Publish the first private bundle release after ZIP extraction and a clean-project installer smoke test pass.
- Keep provider-neutral discovery for Gemini, Grok, Kimi and other CLIs as future scope; the current native worker engines are `fake`, `codex` and `claude`.
