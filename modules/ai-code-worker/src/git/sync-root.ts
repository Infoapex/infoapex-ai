import { isPathInside } from "../state/state-root.js";

export type SyncRootKind = "onedrive" | "dropbox" | "icloud" | "google-drive";
export type SyncRootVerdict = "pass" | "warn" | "block";

export interface SyncRootPolicy {
  readonly sequentialWriter: "warn" | "block";
  readonly parallelWriters: "warn" | "block";
}

export interface SyncRootDetection {
  readonly kind: SyncRootKind;
  readonly root: string;
  readonly evidence: string;
}

export interface EvaluateSyncRootPolicyInput {
  readonly gitCommonDir: string;
  readonly maximumParallelWriters: number;
  readonly policy: SyncRootPolicy;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SyncRootPolicyResult {
  readonly verdict: SyncRootVerdict;
  readonly detection: SyncRootDetection | null;
  readonly writerMode: "sequential" | "parallel";
  readonly message: string;
}

export function evaluateSyncRootPolicy(input: EvaluateSyncRootPolicyInput): SyncRootPolicyResult {
  const detection = detectSyncRoot(input.gitCommonDir, input.env ?? process.env);
  const writerMode = input.maximumParallelWriters > 1 ? "parallel" : "sequential";

  if (!detection) {
    return {
      verdict: "pass",
      detection: null,
      writerMode,
      message: "Git common directory is not under a known sync root."
    };
  }

  const configuredVerdict = writerMode === "parallel" ? input.policy.parallelWriters : input.policy.sequentialWriter;

  return {
    verdict: configuredVerdict,
    detection,
    writerMode,
    message: `${writerMode} writer mode ${configuredVerdict}s because Git common directory is under ${detection.kind}.`
  };
}

/**
 * Mandatory sync-root check for a parallel writer wave (waveSize > 1). Unlike
 * evaluateSyncRootPolicy (used by `doctor`, which may configurably warn), this always
 * blocks parallel writers under a detected sync root (OneDrive/Dropbox/iCloud/Google
 * Drive) regardless of the repository's configured syncRootPolicy - sequential-writer
 * warnings remain a separate, less strict concern handled by doctor.
 */
export function enforceSyncRootForParallelDispatch(
  gitCommonDir: string,
  waveSize: number,
  env: NodeJS.ProcessEnv = process.env
): SyncRootPolicyResult {
  if (waveSize <= 1) {
    return {
      verdict: "pass",
      detection: null,
      writerMode: "sequential",
      message: "Single-writer wave; parallel sync-root enforcement not applicable."
    };
  }

  return evaluateSyncRootPolicy({
    gitCommonDir,
    maximumParallelWriters: waveSize,
    policy: { sequentialWriter: "warn", parallelWriters: "block" },
    env
  });
}

export function detectSyncRoot(path: string, env: NodeJS.ProcessEnv = process.env): SyncRootDetection | null {
  const envRoots: Array<[SyncRootKind, string | undefined, string]> = [
    ["onedrive", env.OneDrive, "OneDrive"],
    ["onedrive", env.OneDriveCommercial, "OneDriveCommercial"],
    ["onedrive", env.OneDriveConsumer, "OneDriveConsumer"],
    ["icloud", env.ICLOUDDRIVE, "ICLOUDDRIVE"],
    ["dropbox", env.DROPBOX, "DROPBOX"],
    ["google-drive", env.GOOGLE_DRIVE, "GOOGLE_DRIVE"]
  ];

  for (const [kind, root, evidence] of envRoots) {
    if (root && isPathInside(root, path)) {
      return { kind, root, evidence };
    }
  }

  return detectByPathSegment(path);
}

function detectByPathSegment(path: string): SyncRootDetection | null {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const knownSegments: Array<[SyncRootKind, string]> = [
    ["onedrive", "onedrive"],
    ["dropbox", "dropbox"],
    ["icloud", "iclouddrive"],
    ["google-drive", "google drive"]
  ];

  for (const [kind, segment] of knownSegments) {
    const index = lowerSegments.findIndex((candidate) => candidate === segment || candidate.startsWith(`${segment} -`));

    if (index >= 0) {
      const root = segments.slice(0, index + 1).join("/");
      return { kind, root, evidence: "path-segment" };
    }
  }

  return null;
}
