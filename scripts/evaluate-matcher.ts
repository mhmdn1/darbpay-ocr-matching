import prisma from '../lib/prisma';
import { MATCHER_CONFIG } from '../lib/services/transaction-matcher';
import { evaluateMatcher, selectAutoMatchThreshold } from '../lib/services/matcher-evaluation';

async function main() {
  // Append-only human decision snapshots are ground truth. AUTO_CONFIRMED
  // rows never grade the same model that created them.
  const events = await prisma.reviewDecisionEvent.findMany({ orderBy: { createdAt: 'asc' } });
  const predictions = events.flatMap((event) => {
    const candidates = parseCandidates(event.candidateSnapshot);
    const actionable = candidates.filter((candidate) => candidate.status === 'CANDIDATE');
    const terminalReject = event.action === 'REJECT' && actionable.length === 1;
    if (event.action !== 'CONFIRM' && !terminalReject) return [];
    const ranked = [...candidates].sort((left, right) =>
      right.decisionConfidence - left.decisionConfidence || (left.rank ?? 999) - (right.rank ?? 999),
    );
    const top = ranked[0];
    if (!top) return [];
    const second = ranked[1];
    const gap = second ? top.decisionConfidence - second.decisionConfidence : top.decisionConfidence;
    return [{
      score: top.decisionConfidence,
      correct: event.action === 'CONFIRM' && top.transactionId === event.transactionId,
      rankOfCorrect: event.action === 'CONFIRM'
        ? ranked.findIndex((candidate) => candidate.transactionId === event.transactionId) + 1 || null
        : null,
      autoMatched:
        top.decisionConfidence >= MATCHER_CONFIG.thresholds.autoMatch &&
        gap >= MATCHER_CONFIG.thresholds.autoMatchGap &&
        top.evidenceCoverage >= MATCHER_CONFIG.thresholds.minAutoEvidenceCoverage &&
        top.contradictions.length === 0,
    }];
  });

  const metrics = evaluateMatcher(predictions);
  const recommendation = selectAutoMatchThreshold(predictions, 0.995);
  console.log(JSON.stringify({ metrics, recommendedThresholdAt99_5Precision: recommendation }, null, 2));
  if (predictions.length < 100) {
    console.warn('Warning: fewer than 100 human-labelled examples; do not deploy a learned threshold yet.');
  }
}

interface SnapshotCandidate {
  transactionId: number;
  rank: number | null;
  decisionConfidence: number;
  evidenceCoverage: number;
  contradictions: string[];
  status: string;
}

function parseCandidates(value: string): SnapshotCandidate[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((candidate): candidate is Omit<SnapshotCandidate, 'contradictions'> & { contradictions: unknown } =>
      typeof candidate === 'object' && candidate !== null &&
      typeof (candidate as SnapshotCandidate).transactionId === 'number' &&
      typeof (candidate as SnapshotCandidate).decisionConfidence === 'number' &&
      typeof (candidate as SnapshotCandidate).evidenceCoverage === 'number' &&
      typeof (candidate as SnapshotCandidate).status === 'string',
    ).map((candidate): SnapshotCandidate => ({
      ...candidate,
      contradictions: parseContradictions(candidate.contradictions),
    }));
  } catch { return []; }
}

function parseContradictions(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

main().finally(() => prisma.$disconnect());
