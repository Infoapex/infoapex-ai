/**
 * The core-local support contract is intentionally small and entirely local.  This
 * checker is used before the test workload starts, so an unsupported host or
 * provider cannot turn a green test run into an accidental support claim.
 */
const support = Object.freeze({
  schemaVersion: "1.0",
  node: { minimumMajor: 22, recommendedMajor: 24, supportedMajors: [22, 24] },
  platforms: ["win32", "linux", "darwin"],
  providers: { fake: "1.0.0" }
});

const options = parseOptions(process.argv.slice(2));
const runtime = options.runtime ?? process.versions.node;
const platform = options.platform ?? process.platform;
const provider = options.provider ?? "fake";
const providerVersion = options.providerVersion ?? "1.0.0";
const diagnostics = [];
const nodeMajor = major(runtime);

if (nodeMajor === null || !support.node.supportedMajors.includes(nodeMajor)) {
  diagnostic("UNSUPPORTED_NODE_RUNTIME", "blocker", support.node.supportedMajors.map(String).join(","), normalizedVersion(runtime));
}
if (!support.platforms.includes(platform)) {
  diagnostic("UNSUPPORTED_PLATFORM", "blocker", support.platforms.join(","), platform || "missing");
}
if (!(provider in support.providers)) {
  diagnostic("UNSUPPORTED_PROVIDER", "blocker", Object.keys(support.providers).join(","), provider || "missing");
} else if (providerVersion !== support.providers[provider]) {
  diagnostic("UNSUPPORTED_PROVIDER_VERSION", "blocker", support.providers[provider], normalizedVersion(providerVersion));
}

if (options.requireProviderCapability && diagnostics.length === 0) {
  // `fake` is the only core-local provider. This probe deliberately has no PATH,
  // credential, network, or vendor-CLI dependency, so CI remains hermetic.
  if (provider === "fake" && typeof process.execPath === "string" && process.execPath.length > 0) {
    diagnostic("PROVIDER_CAPABILITY_AVAILABLE", "info", "fake:local-process", "available");
  } else {
    diagnostic("PROVIDER_CAPABILITY_UNAVAILABLE", "blocker", "fake:local-process", "unavailable");
  }
}

const blocked = diagnostics.some((entry) => entry.severity === "blocker");
const report = {
  schemaVersion: support.schemaVersion,
  status: blocked ? "BLOCKED" : "PASS",
  code: blocked ? "COMPATIBILITY_UNSUPPORTED" : "COMPATIBILITY_SUPPORTED",
  support,
  observed: { runtime: normalizedVersion(runtime), platform, provider, providerVersion: normalizedVersion(providerVersion) },
  diagnostics
};
console.log(JSON.stringify(report));
process.exitCode = blocked ? 2 : 0;

function parseOptions(args) {
  const result = { runtime: null, platform: null, provider: null, providerVersion: null, requireProviderCapability: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--require-provider-capability") { result.requireProviderCapability = true; continue; }
    const key = arg === "--runtime" ? "runtime" : arg === "--platform" ? "platform" : arg === "--provider" ? "provider" : arg === "--provider-version" ? "providerVersion" : null;
    if (!key || index + 1 >= args.length) usage(`Unknown or incomplete option: ${arg}`);
    result[key] = args[++index];
  }
  return result;
}

function major(value) {
  const match = /^(\d+)\./.exec(value ?? "");
  return match ? Number(match[1]) : null;
}

function normalizedVersion(value) {
  return typeof value === "string" && value.length > 0 ? value : "missing";
}

function diagnostic(code, severity, expected, actual) {
  diagnostics.push({ code, severity, expected, actual });
}

function usage(message) {
  console.error(JSON.stringify({ schemaVersion: support.schemaVersion, status: "BLOCKED", code: "COMPATIBILITY_USAGE_INVALID", diagnostics: [{ code: "COMPATIBILITY_USAGE_INVALID", severity: "blocker", expected: "known compatibility options", actual: message }] }));
  process.exit(2);
}
