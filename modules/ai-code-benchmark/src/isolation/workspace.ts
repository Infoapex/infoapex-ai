import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { atomicWriteJson, readJson } from "../persistence/store.js";
import { assertContained, assertPlainPath, canonicalPath, containedPath } from "../security/paths.js";

// Dependencies and build outputs are reproducible workspace inputs, not source
// artifacts. Excluding them keeps isolated benchmark copies bounded and prevents
// a local install (for example frontend/node_modules) from dominating evaluation.
const EXCLUDED_GENERATED_DIRECTORIES = new Set([".git", "node_modules", ".next", "bin", "obj", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);

export interface WorkspaceRecord {
  readonly schemaVersion: "1.0";
  readonly observationId: string;
  readonly experimentHash: string;
  readonly canonicalPath: string;
  readonly strategy: "safe-copy";
}

export function assertSafeWorkspaceTree(directory: string, allowExcludedGitMetadata = false): void {
  assertPlainPath(directory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new Error(`Source repository contains a symlink or junction: ${path}`);
    // Git metadata is not copied into an arm (which prevents an implicit push),
    // but the entry itself must still be plain rather than an escape link.
    if (entry.name === ".git") {
      if (allowExcludedGitMetadata) continue;
      throw new Error(`Evaluation workspace contains forbidden Git metadata: ${path}`);
    }
    if (entry.isDirectory() && EXCLUDED_GENERATED_DIRECTORIES.has(entry.name)) continue;
    if (entry.isDirectory()) assertSafeWorkspaceTree(path, allowExcludedGitMetadata);
    else if (!entry.isFile()) throw new Error(`Workspace contains an unsupported filesystem entry: ${path}`);
  }
}

export function prepareWorkspace(sourceRepository: string, workspacesRoot: string, recordsRoot: string, observationId: string, experimentHash: string): WorkspaceRecord {
  const source = canonicalPath(sourceRepository);
  const workspace = containedPath(workspacesRoot, observationId);
  const recordPath = containedPath(recordsRoot, `${observationId}.json`);
  const record: WorkspaceRecord = { schemaVersion: "1.0", observationId, experimentHash, canonicalPath: workspace, strategy: "safe-copy" };
  atomicWriteJson(recordPath, record); // Reservation precedes creation, making partial preparation recoverable.
  if (existsSync(workspace)) cleanupWorkspace(workspacesRoot, recordPath, observationId, experimentHash);
  assertSafeWorkspaceTree(source, true);
  cpSync(source, workspace, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
    filter: (path) => !EXCLUDED_GENERATED_DIRECTORIES.has(basename(path))
  });
  return record;
}

export interface WorkspaceDiffCapture {
  readonly changedPaths: readonly string[];
  readonly diff: string;
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

/** Compare the evaluator-owned pristine source with the isolated result. This
 * does not rely on agent-controlled Git metadata or self-reported changed paths. */
export function captureWorkspaceDiff(sourceRepository: string, workspacePath: string, maximumBytes = 134_217_728): WorkspaceDiffCapture {
  try {
    const source = canonicalPath(sourceRepository);
    const workspace = canonicalPath(workspacePath);
    assertSafeWorkspaceTree(source, true);
    assertSafeWorkspaceTree(workspace);
    let bytes = 0;
    const inventory = (root: string): Map<string, string> => {
      const values = new Map<string, string>();
      const walk = (directory: string, prefix: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          const stat = lstatSync(path);
          if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new Error(`Workspace contains a symlink or junction: ${relativePath}`);
          if (entry.name === ".git") continue;
          if (entry.isDirectory() && EXCLUDED_GENERATED_DIRECTORIES.has(entry.name)) continue;
          if (entry.isDirectory()) walk(path, relativePath);
          else if (entry.isFile()) {
            bytes += stat.size;
            if (bytes > maximumBytes) throw new Error("Workspace diff exceeded the evaluator byte limit.");
            values.set(relativePath, createHash("sha256").update(readFileSync(path)).digest("hex"));
          } else throw new Error(`Workspace contains an unsupported filesystem entry: ${relativePath}`);
        }
      };
      walk(root, "");
      return values;
    };
    const before = inventory(source);
    const after = inventory(workspace);
    const changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
    return { changedPaths, diff: canonicalJson({ changedPaths }), valid: true, reasons: [] };
  } catch (error) {
    return { changedPaths: [], diff: "", valid: false, reasons: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Atomically move the post-execution tree under private evaluator evidence so
 * cleanup cannot destroy it before deterministic gates and oracles run. */
export function preserveWorkspaceForEvaluation(workspacePath: string, evidenceWorkspacePath: string): void {
  if (!existsSync(workspacePath)) return;
  if (existsSync(evidenceWorkspacePath)) {
    if (rawWorkspaceDigest(workspacePath) === rawWorkspaceDigest(evidenceWorkspacePath)) return;
    throw new Error("Both execution and evaluator workspaces exist for one observation and are not identical.");
  }
  try {
    renameWorkspaceWithRetry(workspacePath, evidenceWorkspacePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
    // A provider descendant or scanner can keep the directory handle open even
    // after all files are readable. Preserve an independently verified copy; the
    // normal cleanup step below removes the execution tree with its own retries.
    cpSync(workspacePath, evidenceWorkspacePath, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    if (rawWorkspaceDigest(workspacePath) !== rawWorkspaceDigest(evidenceWorkspacePath)) {
      rmSync(evidenceWorkspacePath, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      throw new Error("Evaluator evidence copy verification failed: source and copy differ.");
    }
  }
}

/** Evidence preservation must retain even unsafe agent artifacts such as `.git` so
 * the independent evaluator can classify them. This digest validates copy fidelity,
 * while `captureWorkspaceDiff` remains the later security authority. */
function rawWorkspaceDigest(root: string): string {
  const entries: { path: string; sha256: string }[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(path);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new Error(`Evidence copy contains a symlink or junction: ${relative}`);
      if (entry.isDirectory() && EXCLUDED_GENERATED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isDirectory()) walk(path, relative);
      else if (entry.isFile()) entries.push({ path: relative, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
      else throw new Error(`Evidence copy contains an unsupported entry: ${relative}`);
    }
  };
  walk(root, "");
  return createHash("sha256").update(canonicalJson(entries)).digest("hex");
}

/** Windows can retain a short-lived directory handle after a provider process has
 * exited. Retry only the documented transient lock errors; every other filesystem
 * error still fails immediately. The bounded five-second wait preserves fail-closed
 * behavior and lets the append-only runtime resume if the lock never clears. */
export function renameWorkspaceWithRetry(
  source: string,
  destination: string,
  options: {
    readonly rename?: (from: string, to: string) => void;
    readonly wait?: (milliseconds: number) => void;
    readonly attempts?: number;
  } = {}
): void {
  const rename = options.rename ?? renameSync;
  const wait = options.wait ?? ((milliseconds: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  });
  const attempts = options.attempts ?? 21;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "EBUSY" || code === "EPERM" || code === "EACCES";
      if (!retryable || attempt === attempts) throw error;
      wait(250);
    }
  }
}

/** Delete only the exact canonical directory named by an immutable workspace record. */
export function cleanupWorkspace(workspacesRoot: string, recordPath: string, observationId: string, experimentHash: string): void {
  const root = canonicalPath(workspacesRoot);
  const safeRecordPath = assertContained(canonicalPath(join(recordPath, "..")), recordPath);
  const record = readJson<WorkspaceRecord>(safeRecordPath);
  if (Object.keys(record).sort().join("|") !== "canonicalPath|experimentHash|observationId|schemaVersion|strategy") throw new Error("Workspace cleanup record has unknown or missing properties.");
  if (record.schemaVersion !== "1.0" || record.observationId !== observationId || record.experimentHash !== experimentHash || record.strategy !== "safe-copy") {
    throw new Error("Workspace cleanup record does not match the observation.");
  }
  const expected = containedPath(root, observationId);
  if (record.canonicalPath !== expected) throw new Error("Workspace cleanup record contains an unexpected canonical path.");
  if (!existsSync(expected)) return;
  const actual = assertContained(root, expected);
  if (actual !== record.canonicalPath) throw new Error("Workspace canonical path changed after preparation.");
  rmSync(actual, { recursive: true, force: false, maxRetries: 120, retryDelay: 250 });
}
