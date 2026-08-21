import prisma from '@/lib/prisma';
import { loadReviewDecisionHistory } from '@/lib/services/review-history';
import { confirmMatchTx, rejectMatchTx } from '@/lib/services/review-service';
import { resetDatabase, seedBaseData } from './helpers/db';

beforeEach(async () => {
  await resetDatabase();
  await seedBaseData();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createHistoryFixture() {
  const transactions = await prisma.transaction.findMany({ take: 2, orderBy: { id: 'asc' } });
  const suffix = `${Date.now()}-${Math.random()}`;
  const document = await prisma.document.create({
    data: {
      source: 'EMAIL',
      externalId: `history-${suffix}`,
      contentHash: `history-hash-${suffix}`,
      senderIdentifier: 'fleet@alrashed.example',
      status: 'NEEDS_REVIEW',
      merchantName: 'History Receipt Merchant',
      totalAmount: 10000,
      currency: 'SAR',
    },
  });
  const matches = await Promise.all(transactions.map((transaction, index) => (
    prisma.documentMatch.create({
      data: {
        documentId: document.id,
        transactionId: transaction.id,
        confidence: 0.9 - index * 0.1,
        decisionConfidence: 0.82 - index * 0.1,
        evidenceCoverage: 0.8,
        signals: JSON.stringify({ amount: 1, date: 0.8 }),
        rank: index + 1,
      },
    })
  )));
  return { document, matches, transactions };
}

describe('loadReviewDecisionHistory', () => {
  test('shows an individual rejection while the document still needs review', async () => {
    const { document, matches, transactions } = await createHistoryFixture();

    const result = await rejectMatchTx(matches[0].id, 'reviewer@example.com', 'WRONG_AMOUNT');
    expect(result.documentStatus).toBe('NEEDS_REVIEW');

    const history = await loadReviewDecisionHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      documentId: document.id,
      action: 'REJECT',
      reason: 'WRONG_AMOUNT',
      decidedBy: 'reviewer@example.com',
      transaction: {
        id: transactions[0].id,
        merchantName: transactions[0].merchantName,
        decisionConfidence: 0.82,
      },
    });
  });

  test('returns every decision newest-first and preserves decision-time transaction data', async () => {
    const { matches, transactions } = await createHistoryFixture();
    const originalMerchantName = transactions[0].merchantName;

    await rejectMatchTx(matches[0].id, 'reviewer-a', 'WRONG_MERCHANT');
    await confirmMatchTx(matches[1].id, 'reviewer-b');
    await prisma.transaction.update({
      where: { id: transactions[0].id },
      data: { merchantName: 'Merchant renamed after review' },
    });

    const history = await loadReviewDecisionHistory();
    expect(history.map((entry) => [entry.action, entry.reason])).toEqual([
      ['CONFIRM', 'REVIEWER_SELECTED'],
      ['REJECT', 'WRONG_MERCHANT'],
    ]);
    expect(history[1].transaction?.merchantName).toBe(originalMerchantName);
  });
});
