import type { RunAuthorization } from "../authorization/run-authorization.js";
import { freezeManifest } from "../manifest/normalize.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import type { GraphRevision } from "./graph-revision.js";
import type { SupersededRun } from "./superseded-run.js";

export interface SupersededRunReference {
  readonly runId: string;
  readonly graphVersion: number;
  readonly manifestSha256: string;
  readonly authorizationId: string;
  /** The superseded run's own frozen manifest object, re-hashed here only to
   *  prove it was never mutated in place - never written back to disk. */
  readonly manifest: unknown;
}

export interface CreateGraphRevisionInput {
  readonly supersededRun: SupersededRunReference;
  /** A brand-new manifest, already compiled/frozen elsewhere (e.g. by a
   *  repair-driven replan) with an incremented graphVersion and a new runId. */
  readonly newManifest: unknown;
  /** The new manifest's already-bound authorization (see
   *  src/authorization/run-authorization.ts#bindRunAuthorization). */
  readonly newAuthorization: RunAuthorization;
  readonly reason: string;
  readonly now?: string;
  readonly registry?: SchemaRegistry;
}

export interface GraphRevisionRecords {
  readonly revision: GraphRevision;
  readonly supersededRun: SupersededRun;
}

export type GraphRevisionErrorCode =
  | "FROZEN_MANIFEST_MUTATED"
  | "RUN_ID_UNCHANGED"
  | "GRAPH_VERSION_NOT_INCREMENTED"
  | "AUTHORIZATION_NOT_REBOUND";

export class GraphRevisionError extends Error {
  constructor(
    readonly code: GraphRevisionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "GraphRevisionError";
  }
}

/**
 * Enforces IMPLEMENTATION-PLAN.md §10.4: "the frozen manifest never reverts
 * to COMPILED" - a graph revision always creates a new run+graphVersion+
 * authorization rather than editing the superseded run's frozen state.
 *
 * This function does not compile a new manifest or bind a new authorization
 * itself (that's runCompile / bindRunAuthorization's job, reused as-is) - it
 * only verifies the caller actually produced a genuinely new, correctly
 * linked revision, and emits the two audit records (GraphRevision on the new
 * run, SupersededRun on the old one). Every invariant violation throws
 * rather than silently coercing the input into something valid.
 */
export function createGraphRevision(input: CreateGraphRevisionInput): GraphRevisionRecords {
  const registry = input.registry ?? SchemaRegistry.load();
  const now = input.now ?? new Date().toISOString();

  const reFrozenSuperseded = freezeManifest(input.supersededRun.manifest, registry);

  if (reFrozenSuperseded.sha256 !== input.supersededRun.manifestSha256) {
    throw new GraphRevisionError(
      "FROZEN_MANIFEST_MUTATED",
      `Superseded run ${input.supersededRun.runId}'s frozen manifest no longer hashes to ${input.supersededRun.manifestSha256} (got ${reFrozenSuperseded.sha256}) - the frozen manifest must never mutate in place.`
    );
  }

  const frozenNew = freezeManifest(input.newManifest, registry);
  const newManifestView = input.newManifest as { readonly runId: string; readonly graphVersion: number };

  if (newManifestView.runId === input.supersededRun.runId) {
    throw new GraphRevisionError(
      "RUN_ID_UNCHANGED",
      `A graph revision must create a new runId; got the same runId as the superseded run: ${newManifestView.runId}.`
    );
  }

  if (newManifestView.graphVersion !== input.supersededRun.graphVersion + 1) {
    throw new GraphRevisionError(
      "GRAPH_VERSION_NOT_INCREMENTED",
      `Expected graphVersion ${input.supersededRun.graphVersion + 1}, got ${newManifestView.graphVersion}.`
    );
  }

  if (input.newAuthorization.authorizationId === input.supersededRun.authorizationId) {
    throw new GraphRevisionError(
      "AUTHORIZATION_NOT_REBOUND",
      `New authorization reuses the superseded run's authorizationId (${input.supersededRun.authorizationId}) - a revision must bind a new authorization.`
    );
  }

  if (input.newAuthorization.manifestSha256 !== frozenNew.sha256 || input.newAuthorization.runId !== newManifestView.runId) {
    throw new GraphRevisionError(
      "AUTHORIZATION_NOT_REBOUND",
      `New authorization is not bound to the new manifest (runId/manifestSha256 mismatch).`
    );
  }

  const revision: GraphRevision = {
    schemaVersion: "1.0",
    runId: newManifestView.runId,
    graphVersion: newManifestView.graphVersion,
    previousGraphVersion: input.supersededRun.graphVersion,
    supersedesRunId: input.supersededRun.runId,
    reason: input.reason,
    manifestSha256: frozenNew.sha256,
    authorizationId: input.newAuthorization.authorizationId,
    createdAt: now
  };

  registry.assertValid("graph-revision.schema.json", revision);

  const supersededRun: SupersededRun = {
    schemaVersion: "1.0",
    runId: input.supersededRun.runId,
    supersededByRunId: newManifestView.runId,
    supersededByGraphVersion: newManifestView.graphVersion,
    reason: input.reason,
    supersededAt: now
  };

  registry.assertValid("superseded-run.schema.json", supersededRun);

  return { revision, supersededRun };
}
