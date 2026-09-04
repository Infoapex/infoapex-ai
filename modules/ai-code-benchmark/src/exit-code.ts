import type { BenchmarkReport } from "./report.js";

/** Stable process boundary for automation and the root bundle delegate. Security
 * findings outrank statistical verdicts so a fail-closed REJECT is distinguishable
 * from an ordinary candidate regression. */
export function benchmarkReportExitCode(report: Pick<BenchmarkReport, "verdict" | "limitations">): 0 | 4 | 5 | 6 {
  if (report.limitations.includes("CRITICAL_SAFETY_FAILURE")) return 6;
  if (report.verdict === "REJECT") return 4;
  if (report.verdict === "INCONCLUSIVE") return 5;
  return 0;
}
