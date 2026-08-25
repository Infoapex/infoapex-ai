export type DocsEngine = "fake" | "codex" | "claude";

export interface DocsCriterion {
  readonly id: string;
  readonly description: string;
  readonly verify?: readonly string[];
  readonly paths?: readonly string[];
}

export interface DocsRequest {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly docsId: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly prompt: string;
  readonly criteria: readonly DocsCriterion[];
  readonly outputPaths: readonly string[];
  readonly symbols?: readonly string[];
  readonly plannerDraftPath?: string;
  readonly workerPlanPath?: string;
  readonly reviewFixturePath?: string;
}

export interface DocsConfig {
  readonly schemaVersion: "1.0";
  readonly planner: readonly string[];
  readonly worker: readonly string[];
  readonly control: readonly string[];
  readonly review: readonly string[];
  readonly defaultEngine: DocsEngine;
  readonly defaultReviewEngine: DocsEngine;
}

export interface DocsStage {
  readonly status: "PASS" | "BLOCKED";
  readonly message?: string;
  readonly path?: string;
  readonly engine?: string;
  readonly verdict?: "pass" | "fail";
}

export interface DocsReport {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly docsId: string;
  readonly status: "DONE" | "BLOCKED";
  readonly planner: DocsStage;
  readonly control: DocsStage;
  readonly worker: DocsStage & { readonly taskCommits?: Readonly<Record<string, string>> };
  readonly review: DocsStage;
  readonly artifacts: readonly string[];
  readonly taskCommits: Readonly<Record<string, string>>;
  readonly message?: string;
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}
