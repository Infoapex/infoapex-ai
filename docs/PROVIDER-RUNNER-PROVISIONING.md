# Provider runner provisioning

The worker now has a Docker provider runner, but the default installer remains
simulation-only. A real provider profile is valid only after an operator has
provisioned and independently verified all of the following:

1. A pinned runtime image containing both `codex` and `claude` (or the explicitly
   enabled subset), with immutable digests.
2. A Docker network created with `--internal`, used only by the provider runner
   and the egress proxy. The provider container must not be attached to the
   normal `bridge` network.
3. An egress proxy container attached to that internal network and to its
   separately controlled upstream network. The proxy must enforce the provider
   host allowlist, reject all other destinations, and use a pinned image.
4. The same SHA-256 policy identifier on the execution profile, Docker network,
   and proxy container labels:

   ```text
   com.infoapex.ai/provider-egress-policy-sha256=<64 lowercase hex characters>
   com.infoapex.ai/provider-egress-role=proxy
   ```

The execution profile records only credential variable names, never values:

```json
{
  "providerExecution": {
    "mode": "isolated-container",
    "providers": ["codex", "claude"],
    "egressProxy": {
      "networkName": "infoapex-provider-egress",
      "proxyUrl": "http://provider-egress-proxy:3128",
      "policySha256": "<64 lowercase hex characters>",
      "proxyContainer": "provider-egress-proxy",
      "proxyImageDigest": "sha256:<64 lowercase hex characters>"
    },
    "credentialVariables": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
  }
}
```

Every credential named in `credentialVariables` must also appear in
`environment.allowedVariables`. The worker forwards those names to Docker with
`-e NAME`, so the value is read from the Docker client environment and is not
placed in the command argument list or persisted in the repository. Missing
credentials remain a provider/authentication failure; they are never replaced
with a different provider.

The provider runner applies the same read-only root filesystem, capability drop,
no-new-privileges, process/memory/CPU limits, output limits, bounded timeout,
and process-tree cancellation controls as repository execution. Its doctor
probe verifies the pinned image, internal network, proxy container labels and
both provider binaries without invoking a provider request.

The installer deliberately does not create the network, proxy or credentials:
those actions require host privileges and a separately reviewed egress policy.
After provisioning, run:

```text
node dist/src/cli.js config validate --repo <repo> --json
node dist/src/cli.js preflight --repo <repo> --json
node modules/ai-code-worker/dist/src/cli.js doctor --repo <repo> --engine fake --json
node scripts/isolation-preflight.mjs
```

Pentru a instala profilul fără editare manuală în repository, folosește opțiunea
`--execution-profile <file>` a comenzii `init --full`. Fișierul este validat prin
schema workerului înainte de orice scriere; instalarea se oprește fail-closed dacă
profilul este invalid.

The final isolation gate must be `ISOLATION_BACKEND_PROVEN` before a stable
release can be considered. A profile with only the generic Docker image, a
non-internal network, an unlabelled proxy, or an unverified allowlist remains
`BLOCKED`.
