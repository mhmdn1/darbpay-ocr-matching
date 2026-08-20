import prisma from '../lib/prisma';
import { MATCHER_CONFIG } from '../lib/services/transaction-matcher';
import { evaluateMatcher, selectAutoMatchThreshold } from '../lib/services/matcher-evaluation';

async function main() {
  // Only human-confirmed decisions are ground truth. AUTO_CONFIRMED rows must
  // never grade the same model that created them.
  const documents = await prisma.document.findMany({
    where: { matches: { some: { status: 'CONFIRMED' } } },
    include: { matches: { orderBy: [{ rank: 'asc' }, { confidence: 'desc' }] } },
  });

  const predictions = documents.flatMap((document) => {
    const confirmed = document.matches.find((match) => match.status === 'CONFIRMED');
    const ranked = document.matches.filter((match) => match.rank != null || match.status !== 'REJECTED');
    const top = ranked[0];
    if (!confirmed || !top) return [];
    const second = ranked[1];
    const gap = second ? top.confidence - second.confidence : top.confidence;
    const contradictions = safeArray(top.contradictions);
    return [{
      score: top.confidence,
      correct: top.transactionId === confirmed.transactionId,
      rankOfCorrect: ranked.findIndex((match) => match.transactionId === confirmed.transactionId) + 1 || null,
      autoMatched:
        top.confidence >= MATCHER_CONFIG.thresholds.autoMatch &&
        gap >= MATCHER_CONFIG.thresholds.autoMatchGap &&
        top.evidenceCoverage >= MATCHER_CONFIG.thresholds.minAutoEvidenceCoverage &&
        contradictions.length === 0,
    }];
  });

  const metrics = evaluateMatcher(predictions);
  const recommendation = selectAutoMatchThreshold(predictions, 0.995);
  console.log(JSON.stringify({ metrics, recommendedThresholdAt99_5Precision: recommendation }, null, 2));
  if (predictions.length < 100) {
    console.warn('Warning: fewer than 100 human-labelled examples; do not deploy a learned threshold yet.');
  }
}

function safeArray(value: string): unknown[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

main().finally(() => prisma.$disconnect());
