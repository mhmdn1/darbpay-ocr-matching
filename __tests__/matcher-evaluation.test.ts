import {
  calibrateScore,
  evaluateMatcher,
  fitIsotonicCalibrator,
  selectAutoMatchThreshold,
} from '@/lib/services/matcher-evaluation';

describe('matcher evaluation', () => {
  const predictions = [
    { score: 0.99, correct: true, autoMatched: true, rankOfCorrect: 1 },
    { score: 0.90, correct: true, autoMatched: true, rankOfCorrect: 1 },
    { score: 0.85, correct: false, autoMatched: false, rankOfCorrect: 2 },
    { score: 0.40, correct: false, autoMatched: false, rankOfCorrect: null },
  ];

  test('reports ranking, automation, and calibration metrics', () => {
    const metrics = evaluateMatcher(predictions);
    expect(metrics.examples).toBe(4);
    expect(metrics.top1Accuracy).toBe(0.5);
    expect(metrics.recallAtK[1]).toBe(0.5);
    expect(metrics.recallAtK[3]).toBe(0.75);
    expect(metrics.autoPrecision).toBe(1);
    expect(metrics.autoCoverage).toBe(0.5);
    expect(metrics.reviewRate).toBe(0.5);
    expect(metrics.truePositives).toBe(2);
    expect(metrics.falsePositives).toBe(0);
    expect(metrics.trueNegatives).toBe(2);
    expect(metrics.falseNegatives).toBe(0);
    expect(metrics.falsePositiveRate).toBe(0);
    expect(metrics.falseNegativeRate).toBe(0);
    expect(metrics.autoRecall).toBe(1);
    expect(metrics.brierScore).toBeGreaterThan(0);
  });

  test('reports false automatic matches and missed safe automation separately', () => {
    const metrics = evaluateMatcher([
      { score: 0.95, correct: false, autoMatched: true, rankOfCorrect: 2 },
      { score: 0.85, correct: true, autoMatched: false, rankOfCorrect: 1 },
      { score: 0.30, correct: false, autoMatched: false, rankOfCorrect: null },
    ]);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.falseNegatives).toBe(1);
    expect(metrics.falsePositiveRate).toBe(0.5);
    expect(metrics.falseNegativeRate).toBe(1);
    expect(metrics.autoPrecision).toBe(0);
    expect(metrics.autoRecall).toBe(0);
  });

  test('selects a threshold meeting the requested precision', () => {
    const selected = selectAutoMatchThreshold(predictions, 1);
    expect(selected).toEqual(expect.objectContaining({ threshold: 0.9, precision: 1, coverage: 0.5 }));
  });

  test('fits a monotonic isotonic calibrator', () => {
    const calibrator = fitIsotonicCalibrator([
      { score: 0.2, correct: false },
      { score: 0.5, correct: true },
      { score: 0.7, correct: false },
      { score: 0.9, correct: true },
    ]);
    const values = calibrator.map((point) => point.calibratedProbability);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(calibrateScore(0.8, calibrator)).toBeGreaterThanOrEqual(calibrateScore(0.3, calibrator));
  });
});
