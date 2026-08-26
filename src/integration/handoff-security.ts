import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";

const addFormats = addFormatsPlugin as unknown as (ajv: Ajv2020) => void;
const SAFE_RUN_ID = /^(?!\.{1,2}$)(?!.*\.$)[A-Za-z0-9._-]{1,128}$/;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export interface IntegrationConfig {
  readonly schemaVersion: "1.0";
  readonly mode: "independent" | "integrated";
  readonly handoffRoot: string;
  readonly planner?: { readonly enabled?: boolean };
  readonly worker?: { readonly enabled?: boolean };
}

export interface HandoffEnvelope {
  readonly schemaVersion: "1.0";
  readonly handoffId: string;
  readonly direction: "planner-to-worker" | "worker-to-planner";
  readonly createdAt: string;
  readonly runId: string;
  readonly payload: Record<string, unknown>;
}

const schemaDirectory = findSchemaDirectory();
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateConfig = compileSchema("integration-config.schema.json");
const validateHandoffDocument = compileSchema("handoff.schema.json");

export function assertSafeRunId(value: string): void {
  if (!SAFE_RUN_ID.test(value) || WINDOWS_DEVICE_NAME.test(value)) {
    throw new Error(
      "Invalid runId: expected one portable path segment (1-128 ASCII letters, digits, '.', '_' or '-'; '.', '..' and a trailing dot are forbidden)."
    );
  }
}

export function assertPayload(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid handoff payload: expected a JSON object.");
  }
}

export function assertIntegrationConfig(value: unknown): asserts value is IntegrationConfig {
  assertSchema(validateConfig, "integration-config.schema.json", value);
}

export function assertHandoffEnvelope(value: unknown): asserts value is HandoffEnvelope {
  assertSchema(validateHandoffDocument, "handoff.schema.json", value);
}

export function readIntegrationConfig(repositoryPath: string): IntegrationConfig {
  const repositoryRoot = canonicalRepositoryRoot(repositoryPath);
  const configPath = resolveIntegrationConfigPath(repositoryRoot);
  if (!existsSync(configPath)) {
    throw new Error("infoapex-ai is not initialized for this repository");
  }

  const config = parseJsonFile(configPath, "integration config");
  assertIntegrationConfig(config);
  resolveSafeHandoffRoot(repositoryRoot, config.handoffRoot, false);
  return config;
}

export function resolveIntegrationConfigForRead(repositoryPath: string): string {
  return resolveIntegrationConfigPath(canonicalRepositoryRoot(repositoryPath));
}

export function resolveIntegrationRootForWrite(repositoryPath: string): string {
  const repositoryRoot = canonicalRepositoryRoot(repositoryPath);
  const integrationRoot = join(repositoryRoot.lexical, ".infoapex-ai");
  assertContained(repositoryRoot.lexical, integrationRoot, "integration root must stay inside the repository");
  assertNearestExistingAncestorContained(
    repositoryRoot.canonical,
    integrationRoot,
    "integration root escapes the repository through a symlink or junction"
  );
  mkdirSync(integrationRoot, { recursive: true });
  assertContained(repositoryRoot.canonical, realpathSync.native(integrationRoot), "integration root resolves outside the repository");
  return integrationRoot;
}

export function resolveHandoffRootForWrite(repositoryPath: string, configuredRoot: string): string {
  const repositoryRoot = canonicalRepositoryRoot(repositoryPath);
  const handoffRoot = resolveSafeHandoffRoot(repositoryRoot, configuredRoot, true);
  assertContained(repositoryRoot.canonical, realpathSync.native(handoffRoot), "handoffRoot resolves outside the repository");
  return handoffRoot;
}

export function resolveIntegrationReadmeForWrite(repositoryPath: string): string {
  const repositoryRoot = canonicalRepositoryRoot(repositoryPath);
  const readmePath = join(repositoryRoot.lexical, ".infoapex-ai", "README.md");
  assertContained(repositoryRoot.lexical, readmePath, "integration README must stay inside the repository");
  assertNearestExistingAncestorContained(
    repositoryRoot.canonical,
    readmePath,
    "integration README escapes the repository through a symlink or junction"
  );
  if (existsSync(readmePath)) {
    assertContained(repositoryRoot.canonical, realpathSync.native(readmePath), "integration README resolves outside the repository");
  }
  return readmePath;
}

export function resolveHandoffFileForWrite(
  repositoryPath: string,
  configuredRoot: string,
  runId: string,
  fileName: "planner-to-worker.json" | "worker-to-planner.json"
): string {
  assertSafeRunId(runId);
  const repositoryRoot = canonicalRepositoryRoot(repositoryPath);
  const handoffRoot = resolveSafeHandoffRoot(repositoryRoot, configuredRoot, true);
  const canonicalHandoffRoot = realpathSync.native(handoffRoot);
  assertContained(repositoryRoot.canonical, canonicalHandoffRoot, "handoffRoot resolves outside the repository");

  const runDirectory = join(handoffRoot, runId);
  assertContained(handoffRoot, runDirectory, "runId resolves outside handoffRoot");
  assertNearestExistingAncestorContained(canonicalHandoffRoot, runDirectory, "run directory escapes handoffRoot through a symlink or junction");
  mkdirSync(runDirectory, { recursive: true });

  const canonicalRunDirectory = realpathSync.native(runDirectory);
  assertContained(canonicalHandoffRoot, canonicalRunDirectory, "run directory resolves outside handoffRoot");
  const output = join(runDirectory, fileName);
  assertContained(runDirectory, output, "handoff file resolves outside its run directory");
  return output;
}

export function resolveHandoffFileForRead(
  repositoryPath: string,
  configuredRoot: string,
  runId: string,
  fileName: "planner-to-worker.json" | "worker-to-planner.json"
): string {
  assertSafeRunId(runId);
  const repositoryRoot = canonicalRepositoryRoot(repositoryPath);
  const handoffRoot = resolveSafeHandoffRoot(repositoryRoot, configuredRoot, false);
  const runDirectory = join(handoffRoot, runId);
  const input = join(runDirectory, fileName);
  assertContained(handoffRoot, input, "handoff file resolves outside handoffRoot");

  if (existsSync(handoffRoot)) {
    const canonicalHandoffRoot = realpathSync.native(handoffRoot);
    assertContained(repositoryRoot.canonical, canonicalHandoffRoot, "handoffRoot resolves outside the repository");
    assertNearestExistingAncestorContained(canonicalHandoffRoot, input, "handoff file escapes handoffRoot through a symlink or junction");
    if (existsSync(input)) {
      assertContained(canonicalHandoffRoot, realpathSync.native(input), "handoff file resolves outside handoffRoot");
    }
  }

  return input;
}

export function writeJsonCreateNew(path: string, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  let descriptor: number | null = null;

  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, body, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    // Linking a completed same-directory file publishes it atomically and fails
    // with EEXIST instead of replacing an immutable handoff.
    linkSync(temporaryPath, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function parseJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${path}: ${errorMessage(error)}`);
  }
}

interface CanonicalRoot {
  readonly lexical: string;
  readonly canonical: string;
}

function canonicalRepositoryRoot(repositoryPath: string): CanonicalRoot {
  const lexical = resolve(repositoryPath);
  if (!existsSync(lexical) || !statSync(lexical).isDirectory()) {
    throw new Error(`Repository path does not exist or is not a directory: ${lexical}`);
  }
  return { lexical, canonical: realpathSync.native(lexical) };
}

function resolveIntegrationConfigPath(repositoryRoot: CanonicalRoot): string {
  const configPath = join(repositoryRoot.lexical, ".infoapex-ai", "config.json");
  assertContained(repositoryRoot.lexical, configPath, "integration config must stay inside the repository");
  assertNearestExistingAncestorContained(
    repositoryRoot.canonical,
    configPath,
    "integration config escapes the repository through a symlink or junction"
  );
  if (existsSync(configPath)) {
    assertContained(repositoryRoot.canonical, realpathSync.native(configPath), "integration config resolves outside the repository");
  }
  return configPath;
}

function resolveSafeHandoffRoot(repositoryRoot: CanonicalRoot, configured: string, create: boolean): string {
  assertSafeRelativePath(configured, "handoffRoot");
  const handoffRoot = resolve(repositoryRoot.lexical, configured);
  assertContained(repositoryRoot.lexical, handoffRoot, "handoffRoot must stay inside the repository");
  assertNearestExistingAncestorContained(
    repositoryRoot.canonical,
    handoffRoot,
    "handoffRoot escapes the repository through a symlink or junction"
  );
  if (create) mkdirSync(handoffRoot, { recursive: true });
  if (existsSync(handoffRoot)) {
    assertContained(repositoryRoot.canonical, realpathSync.native(handoffRoot), "handoffRoot resolves outside the repository");
  }
  return handoffRoot;
}

function assertSafeRelativePath(value: string, label: string): void {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const hasVolumePrefix = /^[A-Za-z]:/.test(value) || win32.parse(value).root.length > 0;
  if (
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    hasVolumePrefix ||
    normalized.startsWith("/") ||
    segments.includes("..")
  ) {
    throw new Error(`Invalid ${label}: expected a repository-relative path without traversal or volume prefixes.`);
  }
}

function assertNearestExistingAncestorContained(root: string, candidate: string, message: string): void {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(message);
    current = parent;
  }
  assertContained(root, realpathSync.native(current), message);
}

function assertContained(root: string, candidate: string, message: string): void {
  const relation = relative(root, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(message);
  }
}

function findSchemaDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(moduleDirectory, "..", "..", "..", "schemas"), resolve(moduleDirectory, "..", "..", "schemas")];
  const match = candidates.find((candidate) => existsSync(join(candidate, "handoff.schema.json")));
  if (!match) throw new Error("Unable to locate infoapex-ai JSON schemas.");
  return match;
}

function compileSchema(fileName: string): ValidateFunction {
  const path = join(schemaDirectory, fileName);
  const schema = parseJsonFile(path, `${fileName} schema`);
  return ajv.compile(schema as object);
}

function assertSchema(validator: ValidateFunction, schemaName: string, value: unknown): void {
  if (validator(value)) return;
  const issues = (validator.errors ?? []).map(formatSchemaError).join("; ");
  throw new Error(`JSON schema validation failed for ${schemaName}: ${issues || "unknown validation error"}`);
}

function formatSchemaError(error: ErrorObject): string {
  return `${error.instancePath || "/"} ${error.message ?? "validation failed"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
