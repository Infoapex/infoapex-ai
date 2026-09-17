import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function outside(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder);
}

/** Resolve a path without allowing an existing symlink or Windows junction in its ancestry. */
export function canonicalPath(input: string, createDirectory = false): string {
  if (!input || input.includes("\0")) throw new Error("A non-empty filesystem path is required.");
  const absolute = resolve(input);
  const missing: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`No existing ancestor for path: ${absolute}`);
    missing.unshift(cursor);
    cursor = parent;
  }
  assertPlainPath(cursor);
  const realAncestor = realpathSync.native(cursor);
  let canonical = realAncestor;
  for (const entry of missing) canonical = resolve(canonical, entry.slice(dirname(entry).length + 1));
  if (createDirectory) {
    mkdirSync(canonical, { recursive: true });
    assertPlainPath(canonical);
    canonical = realpathSync.native(canonical);
  }
  return canonical;
}

/** Every existing component is checked, not just the leaf, so junction escapes fail closed. */
export function assertPlainPath(input: string): void {
  const absolute = resolve(input);
  const parts: string[] = [];
  let cursor = absolute;
  while (true) {
    parts.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const part of parts) {
    if (!existsSync(part)) break;
    if (lstatSync(part).isSymbolicLink() && !isDarwinSystemAlias(part)) {
      throw new Error(`Symlink or junction is not allowed in benchmark paths: ${part}`);
    }
  }
}

/** macOS exposes stable root aliases such as /var -> /private/var. They are part
 * of the OS filesystem layout and cannot be avoided by tmpdir() callers. Only
 * these exact, verified aliases are allowed; links below them still fail. */
function isDarwinSystemAlias(path: string): boolean {
  if (process.platform !== "darwin") return false;
  const expected = new Map([
    ["/var", "/private/var"],
    ["/tmp", "/private/tmp"],
    ["/etc", "/private/etc"]
  ]);
  const target = expected.get(resolve(path));
  if (!target) return false;
  try { return realpathSync.native(path) === target; } catch { return false; }
}

export function assertSeparateRoots(repositoryPath: string, stateRoot: string): void {
  const repository = canonicalPath(repositoryPath);
  const state = canonicalPath(stateRoot);
  if (!lstatSync(repository).isDirectory()) throw new Error(`Repository path is not a directory: ${repository}`);
  if (existsSync(state) && !lstatSync(state).isDirectory()) throw new Error(`State root is not a directory: ${state}`);
  if (!outside(repository, state) || !outside(state, repository)) {
    throw new Error("Benchmark state root must be outside and separate from the target repository.");
  }
}

export function containedPath(rootInput: string, ...segments: string[]): string {
  const root = canonicalPath(rootInput);
  if (segments.some((segment) => !segment || isAbsolute(segment) || segment === ".." || segment.includes("\0") || segment.split(/[\\/]/u).includes(".."))) {
    throw new Error("Unsafe benchmark path segment.");
  }
  const candidate = resolve(root, ...segments);
  if (outside(root, candidate) || candidate === root) throw new Error(`Benchmark path escapes its root: ${candidate}`);
  assertPlainPath(candidate);
  if (existsSync(candidate)) {
    const realCandidate = realpathSync.native(candidate);
    if (outside(realpathSync.native(root), realCandidate)) throw new Error(`Benchmark path escapes through a symlink or junction: ${candidate}`);
    return realCandidate;
  }
  return candidate;
}

export function assertContained(rootInput: string, candidateInput: string): string {
  const root = canonicalPath(rootInput);
  const candidate = canonicalPath(candidateInput);
  if (candidate === root || outside(root, candidate)) throw new Error(`Path is outside the recorded benchmark root: ${candidate}`);
  return candidate;
}
