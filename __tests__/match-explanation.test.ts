import prisma from '@/lib/prisma';
import {
  explainMatchOnDemand,
  generateLocalExplanation,
  type MatchExplanationGenerator,
  type MatchExplanationInput,
} from '@/lib/services/match-explanation';
import { resetDatabase, seedBaseData } from './helpers/db';

const baseInput: MatchExplanationInput = {
  confidence: 1,
  rank: 1,
  candidateCount: 2,
  topScoreGap: 0,
  evidenceCoverage: 1,
  signals: [
    { name: 'amount', score: 1 },
    { name: 'cardLast4', score: 1 },
    { name: 'date', score: 1 },
    { name: 'merchant', score: 1 },
  ],
  contradictions: [],
  reviewTriggers: ['TOP_CANDIDATES_TOO_CLOSE'],
};

describe('local match explanation', () => {
  test('explains why a perfect-score tie still needs review', () => {
    expect(generateLocalExplanation(baseInput)).toMatch(/another candidate has nearly the same score/i);
  });

  test('prioritizes the already-confirmed transaction safeguard', () => {
    expect(generateLocalExplanation({
      ...baseInput,
      reviewTriggers: ['TRANSACTION_ALREADY_CONFIRMED', 'TOP_CANDIDATES_TOO_CLOSE'],
    })).toMatch(/already has a confirmed document/i);
  });

  test('explains a missing printed date fallback', () => {
    expect(generateLocalExplanation({
      ...baseInput,
      candidateCount: 1,
      topScoreGap: null,
      reviewTriggers: ['RECEIVED_DATE_FALLBACK'],
    })).toMatch(/no reliable printed date/i);
  });

  test('explains why a weak alternative is still shown', () => {
    const text = generateLocalExplanation({
      ...baseInput,
      confidence: 0.44,
      rank: 2,
      candidateCount: 4,
      signals: [
        { name: 'amount', score: 0 },
        { name: 'date', score: 0.89 },
        { name: 'merchant', score: 0.03 },
        { name: 'cardLast4', score: 1 },
      ],
      reviewTriggers: ['BELOW_AUTO_THRESHOLD', 'LOWER_RANKED'],
    });
    expect(text).toMatch(/candidate 2 of 4/i);
    expect(text).toMatch(/amount and merchant do not align/i);
  });
});

describe('on-demand explanation caching', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedBaseData();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('does not exist before the request, then generates once and reuses the stored result', async () => {
    const transaction = await prisma.transaction.findFirstOrThrow({ orderBy: { id: 'asc' } });
    const document = await prisma.document.create({
      data: {
        source: 'EMAIL',
        externalId: 'explanation-cache-test',
        contentHash: 'explanation-cache-hash',
        senderIdentifier: 'fleet@alrashed.example',
        status: 'NEEDS_REVIEW',
        merchantName: 'ALFANAR FUEL STATION',
        totalAmount: 25000,
        currency: 'SAR',
        documentDate: new Date('2025-06-14T08:00:00Z'),
      },
    });
    const match = await prisma.documentMatch.create({
      data: {
        documentId: document.id,
        transactionId: transaction.id,
        confidence: 0.81,
        evidenceCoverage: 0.75,
        rank: 1,
        signals: JSON.stringify({ amount: 1, date: 1, merchant: 1 }),
      },
    });

    expect(match.explanation).toBeNull();

    let calls = 0;
    const generator: MatchExplanationGenerator = {
      async generate() {
        calls += 1;
        return {
          text: `Generated explanation number ${calls} for this candidate.`,
          provider: 'local',
          model: 'test-generator',
        };
      },
    };

    const first = await explainMatchOnDemand(match.id, generator);
    const second = await explainMatchOnDemand(match.id, generator);

    expect(first).toMatchObject({ cached: false, provider: 'local' });
    expect(second).toMatchObject({ cached: true, text: first.text });
    expect(calls).toBe(1);

    await prisma.documentMatch.update({
      where: { id: match.id },
      data: { signals: JSON.stringify({ amount: 1, date: 1, merchant: 0.7 }) },
    });
    const afterEvidenceChange = await explainMatchOnDemand(match.id, generator);
    expect(afterEvidenceChange.cached).toBe(false);
    expect(calls).toBe(2);
  });
});
