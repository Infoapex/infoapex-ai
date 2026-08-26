import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

export type HandoffFileName = 'planner-to-worker.json' | 'worker-to-planner.json';

const SAFE_RUN_ID = /^(?!\.{1,2}$)(?!.*\.$)[A-Za-z0-9._-]{1,128}$/;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export function assertSafeRunId(value: string): void {
  if (!SAFE_RUN_ID.test(value) || WINDOWS_DEVICE_NAME.test(value)) {
    throw new Error(
      "Invalid runId: expected one portable path segment (1-128 ASCII letters, digits, '.', '_' or '-'; '.', '..' and a trailing dot are forbidden).",
    );
  }
}

export function validateConfiguredHandoffRoot(repositoryPath: string, configured: string): string {
  return resolveSafeHandoffRoot(canonicalRepositoryRoot(repositoryPath), configured, false);
}

export function resolveIntegrationConfigForRead(repositoryPath: string): string {
  const repositoryRoot = canonicalRepositoryRoot(repositoryPath);
  const configPath = join(repositoryRoot.lexical, '.infoapex-ai', 'config.json');
  assertContained(repositoryRoot.lexical, configPath, 'integration config must stay inside the repository');
  assertNearestExistingAncestorContained(
    repositoryRoot.canonical,
    configPath,
    'integration config escapes the repository through a symlink or junction',
  );
  if (existsSync(configPath)) {
    assertContained(repositoryRoot.canonical, realpathSync.native(configPath), 'integration config resolves outside the repository');
  }
  return configPath;
}

export function resolveHandoffFileForWrite(
  repositoryPath: string,
  configuredRoot: string,
  runId: string,
  fileName: HandoffFileName,
): string {
  assertSafeRunId(runId);
  const repositoryRoot = canonicalRepositoryRoot(repositoryPath);
  const handoffRoot = resolveSafeHandoffRoot(repositoryRoot, configuredRoot, true);
  const canonicalHandoffRoot = realpathSync.native(handoffRoot);
  assertContained(repositoryRoot.canonical, canonicalHandoffRoot, 'handoffRoot resolves outside the repository');

  const runDirectory = join(handoffRoot, runId);
  assertContained(handoffRoot, runDirectory, 'runId resolves outside handoffRoot');
  assertNearestExistingAncestorContained(
    canonicalHandoffRoot,
    runDirectory,
    'run directory escapes handoffRoot through a symlink or junction',
  );
  mkdirSync(runDirectory, { recursive: true });
  const canonicalRunDirectory = realpathSync.native(runDirectory);
  assertContained(canonicalHandoffRoot, canonicalRunDirectory, 'run directory resolves outside handoffRoot');

  const output = join(runDirectory, fileName);
  assertContained(runDirectory, output, 'handoff file resolves outside its run directory');
  return output;
}

export function resolveHandoffFileForRead(
  repositoryPath: string,
  configuredRoot: string,
  runId: string,
  fileName: HandoffFileName,
): string {
  assertSafeRunId(runId);
  const repositoryRoot = canonicalRepositoryRoot(repositoryPath);
  const handoffRoot = resolveSafeHandoffRoot(repositoryRoot, configuredRoot, false);
  const input = join(handoffRoot, runId, fileName);
  assertContained(handoffRoot, input, 'handoff file resolves outside handoffRoot');

  if (existsSync(handoffRoot)) {
    const canonicalHandoffRoot = realpathSync.native(handoffRoot);
    assertContained(repositoryRoot.canonical, canonicalHandoffRoot, 'handoffRoot resolves outside the repository');
    assertNearestExistingAncestorContained(
      canonicalHandoffRoot,
      input,
      'handoff file escapes handoffRoot through a symlink or junction',
    );
    if (existsSync(input)) {
      assertContained(canonicalHandoffRoot, realpathSync.native(input), 'handoff file resolves outside handoffRoot');
    }
  }

  return input;
}

export function writeJsonCreateNew(path: string, value: unknown): void {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    linkSync(temporaryPath, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
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

function resolveSafeHandoffRoot(repositoryRoot: CanonicalRoot, configured: string, create: boolean): string {
  assertSafeRelativePath(configured, 'handoffRoot');
  const handoffRoot = resolve(repositoryRoot.lexical, configured);
  assertContained(repositoryRoot.lexical, handoffRoot, 'handoffRoot must stay inside the repository');
  assertNearestExistingAncestorContained(
    repositoryRoot.canonical,
    handoffRoot,
    'handoffRoot escapes the repository through a symlink or junction',
  );
  if (create) mkdirSync(handoffRoot, { recursive: true });
  if (existsSync(handoffRoot)) {
    assertContained(repositoryRoot.canonical, realpathSync.native(handoffRoot), 'handoffRoot resolves outside the repository');
  }
  return handoffRoot;
}

function assertSafeRelativePath(value: string, label: string): void {
  const normalized = value.replaceAll('\\', '/');
  const hasVolumePrefix = /^[A-Za-z]:/.test(value) || win32.parse(value).root.length > 0;
  if (
    value.length === 0 ||
    value.includes('\0') ||
    isAbsolute(value) ||
    hasVolumePrefix ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..')
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
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(message);
  }
}
