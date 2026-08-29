import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { ProjectConfig } from "../config/project-config.js";
import type { ContextPackage, ContextPackageSource } from "../context-provider/types.js";
import { canonicalJson, sha256 } from "../manifest/normalize.js";
import type { JsonValue } from "../schema/json-schema.js";

export interface SemanticInputHash {
  readonly canonicalRef: string;
  readonly sha256: string;
}

export interface SemanticTaskInputs {
  readonly contextDigest: string | null;
  readonly contextCompilerVersion: string | null;
  readonly contractHashes: readonly SemanticInputHash[];
  readonly qualityGateConfigHash: string;
  readonly policyHash: string;
  readonly toolchainConfigHash: string;
}

export interface SemanticTaskDescriptor {
  readonly requiredInputs?: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly concurrencyKeys?: readonly string[];
  readonly verify?: readonly string[];
  readonly risk?: string;
  readonly routing?: unknown;
}

export interface BuildSemanticTaskInputsInput {
  readonly repositoryRoot: string;
  readonly task: SemanticTaskDescriptor;
  readonly contextPackage?: ContextPackage;
  readonly projectConfig?: ProjectConfig | null;
}

export function buildSemanticTaskInputsMap(input: {
  readonly repositoryRoot: string;
  readonly tasks: readonly (SemanticTaskDescriptor & { readonly id: string })[];
  readonly contextPackages?: Readonly<Record<string, ContextPackage>> | null;
  readonly projectConfig?: ProjectConfig | null;
}): Readonly<Record<string, SemanticTaskInputs>> {
  return Object.fromEntries(
    [...input.tasks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((task) => [
        task.id,
        buildSemanticTaskInputs({
          repositoryRoot: input.repositoryRoot,
          task,
          contextPackage: input.contextPackages?.[task.id],
          projectConfig: input.projectConfig
        })
      ])
  );
}

const absentHash = sha256(canonicalJson(null));

export function emptySemanticTaskInputs(): SemanticTaskInputs {
  return {
    contextDigest: null,
    contextCompilerVersion: null,
    contractHashes: [],
    qualityGateConfigHash: absentHash,
    policyHash: absentHash,
    toolchainConfigHash: absentHash
  };
}

export function buildSemanticTaskInputs(input: BuildSemanticTaskInputsInput): SemanticTaskInputs {
  const selectedSources = selectedSourceHashes(input.repositoryRoot, input.task.requiredInputs ?? [], input.contextPackage);
  const contractHashes = selectedSources
    .filter((source) => source.sourceType === "contract" || isContractRef(source.canonicalRef))
    .map(toSemanticHash)
    .sort(compareSemanticHash);
  const toolchainHashes = selectedSources
    .filter((source) => isToolchainRef(source.canonicalRef))
    .map(toSemanticHash)
    .sort(compareSemanticHash);

  return {
    contextDigest: input.contextPackage?.contextDigest ?? null,
    contextCompilerVersion: input.contextPackage?.compilerVersion ?? null,
    contractHashes,
    qualityGateConfigHash: hashRelevantQualityGates(input.repositoryRoot, input.task.verify ?? []),
    policyHash: hashJson({
      allowedPaths: sortedUnique(input.task.allowedPaths),
      forbiddenPaths: sortedUnique(input.task.forbiddenPaths),
      concurrencyKeys: sortedUnique(input.task.concurrencyKeys),
      verify: [...(input.task.verify ?? [])],
      risk: input.task.risk ?? null,
      routing: input.task.routing ?? null,
      syncRootPolicy: input.projectConfig?.syncRootPolicy ?? null,
      contextPackageMode: input.projectConfig?.contextPackage?.mode ?? "off"
    }),
    toolchainConfigHash: toolchainHashes.length === 0 ? absentHash : hashJson(toolchainHashes)
  };
}

function selectedSourceHashes(
  repositoryRoot: string,
  requiredInputs: readonly string[],
  contextPackage?: ContextPackage
): Array<{ readonly canonicalRef: string; readonly sha256: string; readonly sourceType: ContextPackageSource["sourceType"] | "file" }> {
  const sources = new Map<string, { readonly canonicalRef: string; readonly sha256: string; readonly sourceType: ContextPackageSource["sourceType"] | "file" }>();

  for (const source of contextPackage?.sources ?? []) {
    sources.set(source.canonicalRef, {
      canonicalRef: source.canonicalRef,
      sha256: source.sourceHash,
      sourceType: source.sourceType
    });
  }

  for (const canonicalRef of [...requiredInputs].sort()) {
    if (sources.has(canonicalRef)) continue;
    const contentHash = hashSafeDeclaredFile(repositoryRoot, canonicalRef);
    if (contentHash) {
      sources.set(canonicalRef, { canonicalRef, sha256: contentHash, sourceType: "file" });
    }
  }

  return [...sources.values()].sort((left, right) => left.canonicalRef.localeCompare(right.canonicalRef));
}

function hashSafeDeclaredFile(repositoryRoot: string, canonicalRef: string): string | null {
  if (!canonicalRef || isAbsolute(canonicalRef) || canonicalRef.includes("\\") || canonicalRef.split("/").includes("..")) {
    return null;
  }
  const root = resolve(repositoryRoot);
  const path = resolve(root, canonicalRef);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return null;
  return sha256(readFileSync(path, "utf8").replace(/\r\n?/g, "\n"));
}

function hashRelevantQualityGates(repositoryRoot: string, verify: readonly string[]): string {
  const canonicalRef = ".ai-code-worker/quality-gates.json";
  const root = resolve(repositoryRoot);
  const path = resolve(root, canonicalRef);
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return absentHash;
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw) as { readonly schemaVersion?: unknown; readonly gates?: readonly { readonly id?: unknown }[] };
    const selectedIds = new Set(verify);
    const relevantGates = (parsed.gates ?? [])
      .filter((gate) => typeof gate.id === "string" && selectedIds.has(gate.id))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    return relevantGates.length === 0
      ? absentHash
      : hashJson({ schemaVersion: parsed.schemaVersion ?? null, gates: relevantGates });
  } catch {
    return sha256(raw.replace(/\r\n?/g, "\n"));
  }
}

function hashJson(value: unknown): string {
  return sha256(canonicalJson(value as JsonValue));
}

function toSemanticHash(source: { readonly canonicalRef: string; readonly sha256: string }): SemanticInputHash {
  return { canonicalRef: source.canonicalRef, sha256: source.sha256 };
}

function compareSemanticHash(left: SemanticInputHash, right: SemanticInputHash): number {
  return left.canonicalRef.localeCompare(right.canonicalRef) || left.sha256.localeCompare(right.sha256);
}

function sortedUnique(values: readonly string[] | undefined): readonly string[] {
  return [...new Set(values ?? [])].sort();
}

function isContractRef(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.startsWith("contracts/") || normalized.includes("/contracts/") || normalized.endsWith(".schema.json");
}

function isToolchainRef(value: string): boolean {
  const normalized = value.toLowerCase();
  const name = normalized.split("/").at(-1) ?? normalized;
  return (
    /^(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig(?:\.[^.]+)?\.json)$/.test(name) ||
    /^(global\.json|nuget\.config|directory\.build\.(?:props|targets)|cargo\.(?:toml|lock)|pyproject\.toml|uv\.lock|dockerfile)$/.test(name) ||
    /^(requirements.*\.txt|.*\.(?:csproj|fsproj|vbproj|sln|slnx))$/.test(name)
  );
}
