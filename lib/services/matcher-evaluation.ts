export interface LabelledPrediction {
  score: number;
  correct: boolean;
  autoMatched: boolean;
  rankOfCorrect?: number | null;
}

export interface EvaluationMetrics {
  examples: number;
  top1Accuracy: number;
  recallAtK: Record<number, number>;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  autoCoverage: number;
  reviewRate: number;
  autoPrecision: number | null;
  autoRecall: number | null;
  brierScore: number;
  expectedCalibrationError: number;
}

export function evaluateMatcher(
  predictions: LabelledPrediction[],
  recallKs: number[] = [1, 3, 5],
  calibrationBins = 10,
): EvaluationMetrics {
  if (predictions.length === 0) {
    return {
      examples: 0, top1Accuracy: 0,
      recallAtK: Object.fromEntries(recallKs.map((k) => [k, 0])),
      truePositives: 0, falsePositives: 0, trueNegatives: 0, falseNegatives: 0,
      falsePositiveRate: 0, falseNegativeRate: 0,
      autoCoverage: 0, reviewRate: 0, autoPrecision: null, autoRecall: null,
      brierScore: 0, expectedCalibrationError: 0,
    };
  }

  const auto = predictions.filter((prediction) => prediction.autoMatched);
  const truePositives = predictions.filter((prediction) => prediction.autoMatched && prediction.correct).length;
  const falsePositives = predictions.filter((prediction) => prediction.autoMatched && !prediction.correct).length;
  const trueNegatives = predictions.filter((prediction) => !prediction.autoMatched && !prediction.correct).length;
  const falseNegatives = predictions.filter((prediction) => !prediction.autoMatched && prediction.correct).length;
  return {
    examples: predictions.length,
    top1Accuracy: mean(predictions.map((prediction) => prediction.correct ? 1 : 0)),
    recallAtK: Object.fromEntries(recallKs.map((k) => [
      k,
      mean(predictions.map((prediction) => prediction.rankOfCorrect != null && prediction.rankOfCorrect <= k ? 1 : 0)),
    ])),
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    falsePositiveRate: ratio(falsePositives, falsePositives + trueNegatives),
    falseNegativeRate: ratio(falseNegatives, falseNegatives + truePositives),
    autoCoverage: auto.length / predictions.length,
    reviewRate: 1 - auto.length / predictions.length,
    autoPrecision: auto.length === 0 ? null : mean(auto.map((prediction) => prediction.correct ? 1 : 0)),
    autoRecall: truePositives + falseNegatives === 0 ? null : ratio(truePositives, truePositives + falseNegatives),
    brierScore: mean(predictions.map((prediction) =>
      (clamp(prediction.score) - (prediction.correct ? 1 : 0)) ** 2,
    )),
    expectedCalibrationError: calibrationError(predictions, calibrationBins),
  };
}

/** Select the lowest threshold satisfying a target precision on labelled data. */
export function selectAutoMatchThreshold(
  predictions: Pick<LabelledPrediction, 'score' | 'correct'>[],
  targetPrecision = 0.995,
): { threshold: number; precision: number; coverage: number } | null {
  const thresholds = [...new Set(predictions.map((prediction) => clamp(prediction.score)))].sort((a, b) => a - b);
  let best: { threshold: number; precision: number; coverage: number } | null = null;
  for (const threshold of thresholds) {
    const selected = predictions.filter((prediction) => prediction.score >= threshold);
    if (selected.length === 0) continue;
    const precision = mean(selected.map((prediction) => prediction.correct ? 1 : 0));
    if (precision >= targetPrecision) {
      const candidate = { threshold, precision, coverage: selected.length / predictions.length };
      if (!best || candidate.coverage > best.coverage) best = candidate;
    }
  }
  return best;
}

export interface IsotonicPoint { maxScore: number; calibratedProbability: number }

/** Pool-adjacent-violators isotonic calibration for monotonically increasing reliability. */
export function fitIsotonicCalibrator(
  examples: Pick<LabelledPrediction, 'score' | 'correct'>[],
): IsotonicPoint[] {
  const sorted = [...examples].sort((a, b) => a.score - b.score);
  const blocks = sorted.map((example) => ({
    maxScore: clamp(example.score), positives: example.correct ? 1 : 0, count: 1,
  }));
  for (let index = 0; index < blocks.length - 1;) {
    const left = blocks[index].positives / blocks[index].count;
    const right = blocks[index + 1].positives / blocks[index + 1].count;
    if (left <= right) { index++; continue; }
    blocks[index] = {
      maxScore: blocks[index + 1].maxScore,
      positives: blocks[index].positives + blocks[index + 1].positives,
      count: blocks[index].count + blocks[index + 1].count,
    };
    blocks.splice(index + 1, 1);
    if (index > 0) index--;
  }
  return blocks.map((block) => ({
    maxScore: block.maxScore,
    calibratedProbability: block.positives / block.count,
  }));
}

export function calibrateScore(score: number, calibrator: IsotonicPoint[]): number {
  if (calibrator.length === 0) return clamp(score);
  return (calibrator.find((point) => score <= point.maxScore) ?? calibrator.at(-1)!).calibratedProbability;
}

function calibrationError(predictions: LabelledPrediction[], binCount: number): number {
  let error = 0;
  for (let bin = 0; bin < binCount; bin++) {
    const lower = bin / binCount;
    const upper = (bin + 1) / binCount;
    const members = predictions.filter((prediction) => {
      const score = clamp(prediction.score);
      return score >= lower && (bin === binCount - 1 ? score <= upper : score < upper);
    });
    if (members.length === 0) continue;
    error += (members.length / predictions.length) * Math.abs(
      mean(members.map((member) => clamp(member.score))) -
      mean(members.map((member) => member.correct ? 1 : 0)),
    );
  }
  return error;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : numerator / denominator; }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
