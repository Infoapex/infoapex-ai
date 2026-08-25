export type PilotVerdict = "PASS" | "FAIL" | "REVIEW_REQUIRED";
export type PilotTaskStatus = "DONE" | "BLOCKED" | "FAILED";
export type RequiredComparableMetric = "elapsedTime" | "humanActiveMinutes" | "humanInterventions";
export type ConditionalComparableMetric = "reportedCostUsd";
export type ComparableMetric = RequiredComparableMetric | ConditionalComparableMetric;

export interface PilotBaseline {
  readonly minimumDoneTasks: number;
  readonly maximumConsecutiveWorkerCausedFailures: number;
  readonly requiredComparableMetrics: readonly RequiredComparableMetric[];
  readonly conditionalComparableMetrics: readonly ConditionalComparableMetric[];
  readonly thresholds: {
    readonly maximumElapsedTimeRatio: number;
    readonly maximumReportedCostRatio: number;
    readonly maximumHumanActiveMinutesRatio: number;
    readonly maximumHumanInterventionsRatio: number;
    readonly maximumHumanInterventionsPerTask: number;
  };
}

export interface PilotTaskResult {
  readonly taskId: string;
  readonly status: PilotTaskStatus;
  readonly workerCausedFailure?: boolean;
  readonly guardrailViolation?: boolean;
  readonly worker: Partial<Record<ComparableMetric, number | null>>;
  readonly baseline: Partial<Record<ComparableMetric, number | null>>;
}

export interface PilotValueGateReport {
  readonly verdict: PilotVerdict;
  readonly doneTasks: number;
  readonly maximumConsecutiveWorkerCausedFailures: number;
  readonly metricResults: readonly PilotMetricResult[];
  readonly findings: readonly PilotValueGateFinding[];
}

export interface PilotMetricResult {
  readonly metric: ComparableMetric;
  readonly compared: boolean;
  readonly workerTotal: number | null;
  readonly baselineTotal: number | null;
  readonly ratio: number | null;
  readonly threshold: number | null;
  readonly status: "PASS" | "REVIEW_REQUIRED" | "SKIPPED";
  readonly reason: string | null;
}

export interface PilotValueGateFinding {
  readonly severity: "blocker" | "review";
  readonly code: string;
  readonly message: string;
}

export function evaluatePilotValueGate(baseline: PilotBaseline, tasks: readonly PilotTaskResult[]): PilotValueGateReport {
  const doneTasks = tasks.filter((task) => task.status === "DONE").length;
  const maximumConsecutiveWorkerCausedFailures = consecutiveWorkerCausedFailures(tasks);
  const findings: PilotValueGateFinding[] = [];

  if (doneTasks < baseline.minimumDoneTasks) {
    findings.push({
      severity: "blocker",
      code: "PILOT_MINIMUM_DONE_TASKS_NOT_MET",
      message: `${doneTasks} DONE tasks is below required minimum ${baseline.minimumDoneTasks}.`
    });
  }

  if (maximumConsecutiveWorkerCausedFailures >= baseline.maximumConsecutiveWorkerCausedFailures) {
    findings.push({
      severity: "blocker",
      code: "PILOT_CONSECUTIVE_WORKER_FAILURES",
      message: `${maximumConsecutiveWorkerCausedFailures} consecutive worker-caused failures meets or exceeds limit ${baseline.maximumConsecutiveWorkerCausedFailures}.`
    });
  }

  const guardrailViolation = tasks.find((task) => task.guardrailViolation === true);
  if (guardrailViolation) {
    findings.push({
      severity: "blocker",
      code: "PILOT_GUARDRAIL_VIOLATION",
      message: `Task ${guardrailViolation.taskId} violated a safety guardrail.`
    });
  }

  const metricResults = [
    ...baseline.requiredComparableMetrics.map((metric) => compareMetric(metric, baseline, tasks, true)),
    ...baseline.conditionalComparableMetrics.map((metric) => compareMetric(metric, baseline, tasks, false))
  ];

  for (const metric of metricResults) {
    if (metric.status === "REVIEW_REQUIRED" && metric.reason) {
      findings.push({
        severity: "review",
        code: "PILOT_METRIC_REVIEW_REQUIRED",
        message: metric.reason
      });
    }
  }

  const verdict = findings.some((finding) => finding.severity === "blocker")
    ? "FAIL"
    : findings.some((finding) => finding.severity === "review")
      ? "REVIEW_REQUIRED"
      : "PASS";

  return {
    verdict,
    doneTasks,
    maximumConsecutiveWorkerCausedFailures,
    metricResults,
    findings
  };
}

function compareMetric(
  metric: ComparableMetric,
  baseline: PilotBaseline,
  tasks: readonly PilotTaskResult[],
  required: boolean
): PilotMetricResult {
  const workerValues = valuesFor(tasks, "worker", metric);
  const baselineValues = valuesFor(tasks, "baseline", metric);
  const threshold = thresholdFor(metric, baseline);

  if (!required && (workerValues.length === 0 || baselineValues.length === 0)) {
    return skipped(metric, "Conditional metric is not comparable for both worker and baseline routes.");
  }

  if (workerValues.length !== tasks.length || baselineValues.length !== tasks.length) {
    return review(metric, sumOrNull(workerValues), sumOrNull(baselineValues), threshold, `Metric ${metric} is missing comparable data.`);
  }

  const workerTotal = sum(workerValues);
  const baselineTotal = sum(baselineValues);

  if (baselineTotal === 0) {
    return compareZeroBaseline(metric, baseline, tasks.length, workerTotal);
  }

  const ratio = workerTotal / baselineTotal;
  const status = ratio <= threshold ? "PASS" : "REVIEW_REQUIRED";

  return {
    metric,
    compared: true,
    workerTotal,
    baselineTotal,
    ratio,
    threshold,
    status,
    reason: status === "PASS" ? null : `Metric ${metric} ratio ${formatNumber(ratio)} exceeds threshold ${threshold}.`
  };
}

function compareZeroBaseline(
  metric: ComparableMetric,
  baseline: PilotBaseline,
  taskCount: number,
  workerTotal: number
): PilotMetricResult {
  if (workerTotal === 0) {
    return {
      metric,
      compared: true,
      workerTotal,
      baselineTotal: 0,
      ratio: 1,
      threshold: thresholdFor(metric, baseline),
      status: "PASS",
      reason: null
    };
  }

  if (metric === "humanInterventions") {
    const absoluteCap = baseline.thresholds.maximumHumanInterventionsPerTask * taskCount;
    const status = workerTotal <= absoluteCap ? "PASS" : "REVIEW_REQUIRED";

    return {
      metric,
      compared: true,
      workerTotal,
      baselineTotal: 0,
      ratio: null,
      threshold: absoluteCap,
      status,
      reason:
        status === "PASS"
          ? null
          : `Metric ${metric} total ${workerTotal} exceeds absolute cap ${absoluteCap} because baseline is zero.`
    };
  }

  return review(
    metric,
    workerTotal,
    0,
    thresholdFor(metric, baseline),
    `Metric ${metric} has zero baseline and no preregistered absolute cap.`
  );
}

function consecutiveWorkerCausedFailures(tasks: readonly PilotTaskResult[]): number {
  let current = 0;
  let maximum = 0;

  for (const task of tasks) {
    if (task.status !== "DONE" && task.workerCausedFailure === true) {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }

  return maximum;
}

function valuesFor(
  tasks: readonly PilotTaskResult[],
  route: "worker" | "baseline",
  metric: ComparableMetric
): number[] {
  return tasks
    .map((task) => task[route][metric])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function thresholdFor(metric: ComparableMetric, baseline: PilotBaseline): number {
  switch (metric) {
    case "elapsedTime":
      return baseline.thresholds.maximumElapsedTimeRatio;
    case "humanActiveMinutes":
      return baseline.thresholds.maximumHumanActiveMinutesRatio;
    case "humanInterventions":
      return baseline.thresholds.maximumHumanInterventionsRatio;
    case "reportedCostUsd":
      return baseline.thresholds.maximumReportedCostRatio;
  }
}

function skipped(metric: ComparableMetric, reason: string): PilotMetricResult {
  return {
    metric,
    compared: false,
    workerTotal: null,
    baselineTotal: null,
    ratio: null,
    threshold: null,
    status: "SKIPPED",
    reason
  };
}

function review(
  metric: ComparableMetric,
  workerTotal: number | null,
  baselineTotal: number | null,
  threshold: number,
  reason: string
): PilotMetricResult {
  return {
    metric,
    compared: false,
    workerTotal,
    baselineTotal,
    ratio: null,
    threshold,
    status: "REVIEW_REQUIRED",
    reason
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
