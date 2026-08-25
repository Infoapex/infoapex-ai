export function versionMatchesAny(version: string, ranges: readonly string[]): boolean {
  return ranges.some((range) => versionMatches(version, range));
}

export function versionMatches(version: string, range: string): boolean {
  if (range === version) {
    return true;
  }

  if (range.endsWith(".x")) {
    return version.startsWith(range.slice(0, -1));
  }

  return false;
}
