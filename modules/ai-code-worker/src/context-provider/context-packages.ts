import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { redactText } from "../runner/redaction.js";
import { computeContextPackageDigest } from "./context-package-digest.js";
import type { ContextPackage, ContextProvider, ContextProviderCallResult } from "./types.js";

export type ContextPackageMode = "off" | "observe" | "enforce";
export type ContextPackageResult = ContextProviderCallResult<ContextPackage>;

export interface CompileTaskContextPackagesInput {
  readonly provider: ContextProvider;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly maximumTokens: number;
}

export async function compileTaskContextPackages(
  input: CompileTaskContextPackagesInput
): Promise<Readonly<Record<string, ContextPackageResult>>> {
  const manifest = JSON.parse(readFileSync(input.manifestPath, "utf8")) as {
    readonly runId: string;
    readonly tasks: readonly { readonly id: string }[];
  };
  const entries = await Promise.all(
    [...manifest.tasks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(async (task) => {
        const result = await input.provider.compileContext({
          manifestPath: input.manifestPath,
          manifestSha256: input.manifestSha256,
          taskId: task.id,
          maximumTokens: input.maximumTokens
        });
        return [task.id, validateBindingAndDigest(result, manifest.runId, task.id, input.manifestSha256)] as const;
      })
  );

  return Object.fromEntries(entries);
}

export interface ContextPackageArtifactIndex {
  readonly schemaVersion: "1.0";
  readonly mode: ContextPackageMode;
  readonly packages: readonly {
    readonly taskId: string;
    readonly status: ContextPackageResult["status"];
    readonly contextDigest?: string;
    readonly path?: string;
    readonly reason?: string;
    readonly sources?: readonly {
      readonly sourceId: string;
      readonly canonicalRef: string;
      readonly sourceHash: string;
      readonly authority: string;
    }[];
  }[];
}

export function writeContextPackageArtifacts(
  runRoot: string,
  mode: ContextPackageMode,
  results: Readonly<Record<string, ContextPackageResult>>
): ContextPackageArtifactIndex {
  const packages = Object.entries(results)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taskId, result]) => {
      if (result.status !== "OK") {
        return { taskId, status: result.status, reason: result.reason };
      }

      const path = join(runRoot, "tasks", taskId, "context-package.v1.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(result.value, null, 2)}\n`, "utf8");
      return {
        taskId,
        status: result.status,
        contextDigest: result.value.contextDigest,
        path: relative(runRoot, path).replaceAll("\\", "/"),
        sources: result.value.sources.map((source) => ({
          sourceId: source.sourceId,
          canonicalRef: source.canonicalRef,
          sourceHash: source.sourceHash,
          authority: source.authority
        }))
      };
    });

  const index: ContextPackageArtifactIndex = { schemaVersion: "1.0", mode, packages };
  writeFileSync(join(runRoot, "context-package-index.v1.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export function successfulContextPackages(
  results: Readonly<Record<string, ContextPackageResult>>
): Readonly<Record<string, ContextPackage>> {
  return Object.fromEntries(
    Object.entries(results)
      .filter((entry): entry is [string, { readonly status: "OK"; readonly value: ContextPackage }] => entry[1].status === "OK")
      .map(([taskId, result]) => [taskId, result.value])
  );
}

export function failedContextPackageTasks(results: Readonly<Record<string, ContextPackageResult>>): readonly string[] {
  return Object.entries(results)
    .filter(([, result]) => result.status !== "OK")
    .map(([taskId]) => taskId)
    .sort();
}

function validateBindingAndDigest(
  result: ContextPackageResult,
  runId: string,
  taskId: string,
  manifestSha256: string
): ContextPackageResult {
  if (result.status !== "OK") {
    return result;
  }

  const contextPackage = result.value;
  if (
    contextPackage.runId !== runId ||
    contextPackage.taskId !== taskId ||
    contextPackage.manifestSha256 !== manifestSha256
  ) {
    return { status: "ERROR", reason: `context package binding mismatch for task ${taskId}` };
  }

  if (computeContextPackageDigest(contextPackage) !== contextPackage.contextDigest) {
    return { status: "ERROR", reason: `context package digest mismatch for task ${taskId}` };
  }

  const blockingDiagnostics = contextPackage.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (blockingDiagnostics.length > 0) {
    return {
      status: "ERROR",
      reason: `context package has blocking diagnostics for task ${taskId}: ${blockingDiagnostics.map((item) => item.code).join(", ")}`
    };
  }

  const persistedText = [
    ...contextPackage.sources.flatMap((source) => [source.selectionReason, source.renderedContent ?? ""]),
    ...contextPackage.diagnostics.map((diagnostic) => diagnostic.message)
  ].join("\n");
  if (redactText(persistedText).redacted) {
    return { status: "ERROR", reason: `context package contains unredacted secret-looking content for task ${taskId}` };
  }

  return result;
}
