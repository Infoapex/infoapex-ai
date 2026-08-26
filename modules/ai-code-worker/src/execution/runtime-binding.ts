import type { RunAuthorization } from "../authorization/run-authorization.js";
import { loadExecutionProfile } from "../compile/compile.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import {
  createExecutionBackendBinding,
  type ExecutionBackendBinding
} from "./environment.js";

/** Re-loads the profile immediately before writer execution and proves that it
 * is the exact profile frozen into authorization.json. This closes the gap
 * between a passing preflight and the backend actually used by the adapter. */
export function loadAuthorizedExecutionBinding(
  repositoryRoot: string,
  authorization: RunAuthorization,
  registry = SchemaRegistry.load()
): ExecutionBackendBinding {
  const profile = loadExecutionProfile(repositoryRoot);
  const binding = createExecutionBackendBinding(profile, process.env, registry);
  const report = binding.backend.probe(profile);
  const expected = authorization.executionEnvironment;

  if (
    report.profileId !== expected.profileId ||
    report.kind !== expected.kind ||
    report.profileSha256 !== expected.profileSha256
  ) {
    throw new Error(
      "AUTHORIZATION_MISMATCH: execution profile changed after authorization binding. Start a new run."
    );
  }

  if (report.kind === "trusted-local" && authorization.trustedLocalAuthorization === undefined) {
    throw new Error(
      "AUTHORIZATION_MISMATCH: trusted-local execution has no external authorization record."
    );
  }

  return binding;
}
