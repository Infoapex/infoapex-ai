import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { normalize, posix, win32 } from "node:path";

type PathApi = typeof posix;

export interface ResolveStateRootOptions {
  readonly repoRoot: string;
  readonly configuredStateRoot?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

export interface ResolvedStateRoot {
  readonly path: string;
  readonly source: "configured" | "default";
  readonly repoHash: string;
  readonly insideRepository: boolean;
}

export function resolveStateRoot(options: ResolveStateRootOptions): ResolvedStateRoot {
  const pathApi = pathApiFor(options.platform ?? process.platform);
  const repoRoot = pathApi.resolve(options.repoRoot);
  const repoHash = repositoryHash(canonicalRepoRootForHash(repoRoot));
  const configured = options.configuredStateRoot;

  const stateRoot = configured
    ? resolvePath(configured, repoRoot, pathApi)
    : pathApi.resolve(defaultStateBase(options, pathApi), "ai-code-worker", "repos", repoHash);

  return {
    path: stateRoot,
    source: configured ? "configured" : "default",
    repoHash,
    insideRepository: isPathInside(repoRoot, stateRoot, pathApi)
  };
}

export function repositoryHash(repoRoot: string): string {
  return createHash("sha256").update(normalize(repoRoot).toLowerCase(), "utf8").digest("hex").slice(0, 16);
}

/**
 * Different callers arrive at "the repo root" through different paths that are not
 * always the same string: `gitPreflight()` uses `git rev-parse --show-toplevel`
 * (compile.ts, doctor.ts, status.ts), while a few call sites and most tests pass a raw
 * `--repo`/`mkdtempSync()` string directly (usage-checkpoint.ts, cli.ts). `path.resolve`
 * alone cannot reconcile them - it is pure string manipulation, not filesystem-aware -
 * so on a host where the OS/shell resolves one of those forms to a different real path
 * (confirmed live on GitHub Actions windows-latest, 2026-09-02: five ai-code-worker
 * tests failed because two `resolveStateRoot()` calls for the "same" repo produced two
 * different hashes and thus two different state directories), the hash silently
 * diverges and a run's own state becomes unfindable by a second, differently-phrased
 * lookup. `realpathSync` resolves both forms to the same canonical filesystem path
 * before hashing, closing that gap at the source. Falls back to the syntactic path when
 * the directory does not exist yet (e.g. `doctor` probing a path before `init`) - never
 * throws for a caller that has not created the repo yet.
 */
function canonicalRepoRootForHash(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return repoRoot;
  }
}

export function isPathInside(parent: string, child: string, pathApi: PathApi = pathApiFor(process.platform)): boolean {
  const relationship = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));

  return relationship === "" || (!!relationship && !relationship.startsWith("..") && !pathApi.isAbsolute(relationship));
}

function resolvePath(path: string, base: string, pathApi: PathApi): string {
  return pathApi.isAbsolute(path) ? pathApi.normalize(path) : pathApi.resolve(base, path);
}

function defaultStateBase(options: ResolveStateRootOptions, pathApi: PathApi): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homedir();

  if (platform === "win32") {
    return env.LOCALAPPDATA || pathApi.resolve(home, "AppData", "Local");
  }

  if (platform === "darwin") {
    return pathApi.resolve(home, "Library", "Application Support");
  }

  return env.XDG_STATE_HOME || pathApi.resolve(home, ".local", "state");
}

function pathApiFor(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? win32 : posix;
}
