import prisma from '@/lib/prisma';
import { confirmMatchTx, rejectMatchTx } from '@/lib/services/review-service';
import { resetDatabase, seedBaseData } from './helpers/db';

beforeEach(async () => {
  await resetDatabase();
  await seedBaseData();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createReviewDocument(transactionIds: number[]) {
  const suffix = `${Date.now()}-${Math.random()}`;
  const document = await prisma.document.create({
    data: {
      source: 'EMAIL',
      externalId: `review-${suffix}`,
      contentHash: `hash-${suffix}`,
      senderIdentifier: 'fleet@alrashed.example',
      status: 'NEEDS_REVIEW',
    },
  });

  const matches = [];
  for (const [index, transactionId] of transactionIds.entries()) {
    matches.push(await prisma.documentMatch.create({
      data: {
        documentId: document.id,
        transactionId,
        confidence: 0.9 - index * 0.1,
        signals: JSON.stringify({ amount: 1, date: 0.8 }),
      },
    }));
  }
  return { document, matches };
}

describe('confirmMatchTx', () => {
  test('confirms the selected candidate, rejects siblings, and is idempotent', async () => {
    const transactions = await prisma.transaction.findMany({ take: 2, orderBy: { id: 'asc' } });
    const { document, matches } = await createReviewDocument(transactions.map((tx) => tx.id));

    const first = await confirmMatchTx(matches[0].id, 'reviewer@example.com');
    const replay = await confirmMatchTx(matches[0].id, 'reviewer@example.com');

    expect(first).toMatchObject({ documentId: document.id, documentStatus: 'MATCHED', matchStatus: 'CONFIRMED' });
    expect(replay).toMatchObject({ documentStatus: 'MATCHED', matchStatus: 'CONFIRMED' });

    const stored = await prisma.documentMatch.findMany({
      where: { documentId: document.id },
      orderBy: { id: 'asc' },
    });
    expect(stored[0]).toMatchObject({ status: 'CONFIRMED', decidedBy: 'reviewer@example.com' });
    expect(stored[1]).toMatchObject({ status: 'REJECTED', decidedBy: 'system' });
  });

  test('refuses a second confirmed document for the same transaction', async () => {
    const transaction = await prisma.transaction.findFirstOrThrow();
    const first = await createReviewDocument([transaction.id]);
    const second = await createReviewDocument([transaction.id]);

    await confirmMatchTx(first.matches[0].id, 'reviewer-a');
    await expect(confirmMatchTx(second.matches[0].id, 'reviewer-b'))
      .rejects.toThrow(/already has a confirmed document/i);
  });

  test('database partial index rejects a second confirmation even outside the service', async () => {
    const transaction = await prisma.transaction.findFirstOrThrow();
    const first = await createReviewDocument([transaction.id]);
    const second = await createReviewDocument([transaction.id]);

    await prisma.documentMatch.update({
      where: { id: first.matches[0].id },
      data: { status: 'CONFIRMED' },
    });
    await expect(prisma.documentMatch.update({
      where: { id: second.matches[0].id },
      data: { status: 'CONFIRMED' },
    })).rejects.toThrow();
  });
});

describe('rejectMatchTx', () => {
  test('rejects a candidate, keeps review open, then marks the document unmatched', async () => {
    const transactions = await prisma.transaction.findMany({ take: 2, orderBy: { id: 'asc' } });
    const { document, matches } = await createReviewDocument(transactions.map((tx) => tx.id));

    const first = await rejectMatchTx(matches[0].id, 'reviewer@example.com');
    expect(first.documentStatus).toBe('NEEDS_REVIEW');

    const actionableAfterFirstReject = await prisma.documentMatch.findMany({
      where: { documentId: document.id, status: 'CANDIDATE' },
    });
    expect(actionableAfterFirstReject.map((match) => match.id)).toEqual([matches[1].id]);

    const last = await rejectMatchTx(matches[1].id, 'reviewer@example.com');
    const replay = await rejectMatchTx(matches[1].id, 'reviewer@example.com');
    expect(last.documentStatus).toBe('UNMATCHED');
    expect(replay.matchStatus).toBe('REJECTED');

    const stored = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(stored.status).toBe('UNMATCHED');
  });

  test('cannot reject an already-confirmed match', async () => {
    const transaction = await prisma.transaction.findFirstOrThrow();
    const { matches } = await createReviewDocument([transaction.id]);
    await confirmMatchTx(matches[0].id, 'reviewer');
    await expect(rejectMatchTx(matches[0].id, 'reviewer')).rejects.toThrow(/cannot reject/i);
  });
});
