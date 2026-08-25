import { createHash } from "node:crypto";
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
  const repoHash = repositoryHash(repoRoot);
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
