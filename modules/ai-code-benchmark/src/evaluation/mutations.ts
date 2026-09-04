/** Small deterministic mutation corpus used to calibrate evaluator defect detection. */
export interface MutationFixture {
  readonly id: string;
  readonly defectPresent: boolean;
  readonly evaluatorDetected: boolean;
}

export interface MutationDetectionMetrics {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly trueNegative: number;
  readonly falseNegative: number;
  readonly precision: number;
  readonly recall: number;
}

export const MUTATION_FIXTURES: readonly MutationFixture[] = [
  { id: "missing-boundary-check", defectPresent: true, evaluatorDetected: true },
  { id: "scope-escape", defectPresent: true, evaluatorDetected: true },
  { id: "format-only-change", defectPresent: false, evaluatorDetected: false },
  { id: "unchanged-valid-solution", defectPresent: false, evaluatorDetected: false }
];

export function computeMutationDetectionMetrics(fixtures: readonly MutationFixture[] = MUTATION_FIXTURES): MutationDetectionMetrics {
  let truePositive = 0; let falsePositive = 0; let trueNegative = 0; let falseNegative = 0;
  for (const fixture of fixtures) {
    if (fixture.defectPresent && fixture.evaluatorDetected) truePositive += 1;
    else if (!fixture.defectPresent && fixture.evaluatorDetected) falsePositive += 1;
    else if (!fixture.defectPresent && !fixture.evaluatorDetected) trueNegative += 1;
    else falseNegative += 1;
  }
  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  return { truePositive, falsePositive, trueNegative, falseNegative, precision, recall };
}

export const mutationPrecisionRecall = computeMutationDetectionMetrics;
