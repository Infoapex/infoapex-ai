import { readFileSync } from "node:fs";
import { loadExecutionProfile } from "../compile/compile.js";
import { createClaudeIndependentReviewer, createCodexIndependentReviewer } from "./independent-reviewer-cli.js";
import { loadReviewFixture } from "./review-fixture.js";
import type { IndependentReviewResult } from "./independent-review.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import { resolveExecutionEnvironment } from "../execution/environment.js";

export interface ReadOnlyReviewRequest {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly reviewId: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly graphVersion?: number;
  readonly criteria: readonly { readonly id: string; readonly description: string; readonly verify?: readonly string[]; readonly paths?: readonly string[] }[];
  readonly controlContext?: string;
}

export interface ReadOnlyReviewOptions {
  readonly repositoryPath: string;
  readonly inputPath: string;
  readonly engine: "fake" | "codex" | "claude";
  readonly fixturePath?: string;
  readonly executable?: string;
  readonly model?: string;
}

export function runReadOnlyReview(options: ReadOnlyReviewOptions): {
  readonly status: "DONE" | "BLOCKED";
  readonly runId: string;
  readonly review?: IndependentReviewResult;
  readonly engine: string;
  readonly message?: string;
} {
  try {
    const registry = SchemaRegistry.load();
    const request = JSON.parse(readFileSync(options.inputPath, "utf8")) as ReadOnlyReviewRequest;
    registry.assertValid("review-request.schema.json", request);

    const tasks = request.criteria.map((criterion) => ({
      id: criterion.id,
      acceptanceCriteria: [criterion.description],
      criterionIds: [criterion.id]
    }));
    const processRunner = options.engine === "fake"
      ? undefined
      : (() => {
          try {
            const profile = loadExecutionProfile(options.repositoryPath);
            const environment = resolveExecutionEnvironment(profile, registry);
            const report = environment.doctor(profile);
            return report.providerSupported
              ? environment.providerProcessRunner?.(profile, options.engine) ?? null
              : null;
          } catch {
            return null;
          }
        })();

    const base = {
      repositoryPath: options.repositoryPath,
      baseCommit: request.baseCommit,
      tasks,
      context: request.controlContext,
      config: {
        ...(options.executable ? { executable: options.executable } : {}),
        ...(options.model ? { defaultModel: options.model } : {}),
        ...(options.engine !== "fake" ? { processRunner } : {})
      }
    };

    let review: IndependentReviewResult;
    if (options.engine === "fake") {
      if (!options.fixturePath) throw new Error("Fake review requires --fixture.");
      review = loadReviewFixture(options.fixturePath, registry);
    } else {
      const reviewer = options.engine === "codex"
        ? createCodexIndependentReviewer(base)
        : createClaudeIndependentReviewer(base);
      const taskCommits = Object.fromEntries(request.criteria.map((criterion) => [criterion.id, request.headCommit]));
      review = reviewer({
        runId: request.runId,
        graphVersion: request.graphVersion ?? 1,
        taskCommits
      });
    }

    const engineFailure = review.findings.some((finding) => finding.id === "REV-ENGINE-FAILURE");
    return {
      status: engineFailure ? "BLOCKED" : "DONE",
      runId: request.runId,
      review,
      engine: options.engine,
      ...(engineFailure ? { message: "The review engine did not produce a valid review." } : {})
    };
  } catch (error) {
    return {
      status: "BLOCKED",
      runId: "unknown",
      engine: options.engine,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
