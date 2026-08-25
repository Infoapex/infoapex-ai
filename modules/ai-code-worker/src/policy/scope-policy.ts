import { isAbsolute, normalize } from "node:path";

export interface TaskScopePolicy {
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
}

export interface ScopePolicyResult {
  readonly status: "PASS" | "BLOCK";
  readonly findings: readonly ScopePolicyFinding[];
}

export interface ScopePolicyFinding {
  readonly code: "PATH_OUTSIDE_SCOPE" | "PATH_FORBIDDEN" | "PATH_PATTERN_UNSAFE";
  readonly path: string;
  readonly message: string;
}

export function evaluateChangedPaths(scope: TaskScopePolicy, changedPaths: readonly string[]): ScopePolicyResult {
  const findings: ScopePolicyFinding[] = [];
  const unsafePatterns = [...scope.allowedPaths, ...scope.forbiddenPaths].filter((pattern) => !isSafeRelativePattern(pattern));

  for (const pattern of unsafePatterns) {
    findings.push({
      code: "PATH_PATTERN_UNSAFE",
      path: pattern,
      message: `Scope pattern is not a safe repository-relative path: ${pattern}`
    });
  }

  for (const changedPath of changedPaths) {
    const normalized = normalizePolicyPath(changedPath);

    if (!normalized) {
      findings.push({
        code: "PATH_OUTSIDE_SCOPE",
        path: changedPath,
        message: `Changed path escapes the repository scope: ${changedPath}`
      });
      continue;
    }

    if (scope.forbiddenPaths.some((pattern) => matchesPolicyPattern(pattern, normalized))) {
      findings.push({
        code: "PATH_FORBIDDEN",
        path: normalized,
        message: `Changed path is explicitly forbidden: ${normalized}`
      });
      continue;
    }

    if (!scope.allowedPaths.some((pattern) => matchesPolicyPattern(pattern, normalized))) {
      findings.push({
        code: "PATH_OUTSIDE_SCOPE",
        path: normalized,
        message: `Changed path is not covered by allowedPaths: ${normalized}`
      });
    }
  }

  return {
    status: findings.length > 0 ? "BLOCK" : "PASS",
    findings
  };
}

export function matchesPolicyPattern(pattern: string, path: string): boolean {
  const normalizedPattern = normalizePolicyPath(pattern);
  const normalizedPath = normalizePolicyPath(path);

  if (!normalizedPattern || !normalizedPath) {
    return false;
  }

  if (normalizedPattern === "**") {
    return true;
  }

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(`^${escapeRegex(normalizedPattern).replaceAll("*", "[^/]*")}$`);
    return regex.test(normalizedPath);
  }

  return normalizedPath === normalizedPattern;
}

export function normalizePolicyPath(path: string): string | null {
  const slashPath = path.replaceAll("\\", "/");

  if (isAbsolute(path) || slashPath.startsWith("/") || slashPath.includes("\0")) {
    return null;
  }

  const normalized = normalize(slashPath).replaceAll("\\", "/");

  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    return null;
  }

  return normalized;
}

function isSafeRelativePattern(pattern: string): boolean {
  return normalizePolicyPath(pattern) !== null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
