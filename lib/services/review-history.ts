import prisma from '@/lib/prisma';

export type ReviewDecisionAction = 'CONFIRM' | 'REJECT';

export interface ReviewDecisionTransactionSnapshot {
  id: number;
  merchantName: string;
  amount: number;
  currency: string;
  transactionAt: string;
  cardLast4: string;
  decisionConfidence: number | null;
}

export interface ReviewDecisionHistoryRow {
  eventId: number;
  documentId: number;
  source: string;
  documentMerchantName: string | null;
  documentTotalAmount: number | null;
  documentCurrency: string | null;
  action: ReviewDecisionAction;
  reason: string;
  decidedBy: string;
  matcherVersion: string;
  occurredAt: Date;
  transaction: ReviewDecisionTransactionSnapshot | null;
}

/**
 * Read the immutable reviewer audit trail used by Processing history.
 *
 * The transaction shown to the reviewer comes from the decision-time snapshot,
 * not the mutable current Transaction/DocumentMatch rows. This keeps history
 * accurate if transaction descriptions or matcher output change later.
 */
export async function loadReviewDecisionHistory(limit = 100): Promise<ReviewDecisionHistoryRow[]> {
  const events = await prisma.reviewDecisionEvent.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.max(1, Math.min(limit, 200)),
    select: {
      id: true,
      documentId: true,
      transactionId: true,
      action: true,
      reason: true,
      decidedBy: true,
      matcherVersion: true,
      candidateSnapshot: true,
      createdAt: true,
      document: {
        select: {
          source: true,
          merchantName: true,
          totalAmount: true,
          currency: true,
        },
      },
    },
  });

  return events.map((event) => ({
    eventId: event.id,
    documentId: event.documentId,
    source: event.document.source,
    documentMerchantName: event.document.merchantName,
    documentTotalAmount: event.document.totalAmount,
    documentCurrency: event.document.currency,
    action: event.action === 'CONFIRM' ? 'CONFIRM' : 'REJECT',
    reason: event.reason,
    decidedBy: event.decidedBy,
    matcherVersion: event.matcherVersion,
    occurredAt: event.createdAt,
    transaction: transactionFromSnapshot(event.candidateSnapshot, event.transactionId),
  }));
}

function transactionFromSnapshot(
  snapshot: string,
  transactionId: number,
): ReviewDecisionTransactionSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(snapshot);
    if (!Array.isArray(parsed)) return null;

    const candidate = parsed.find((item) => isRecord(item) && item.transactionId === transactionId);
    if (!isRecord(candidate) || !isRecord(candidate.transaction)) return null;

    const transaction = candidate.transaction;
    if (
      typeof transaction.merchantName !== 'string' ||
      typeof transaction.amount !== 'number' ||
      typeof transaction.currency !== 'string' ||
      typeof transaction.transactionAt !== 'string' ||
      typeof transaction.cardLast4 !== 'string'
    ) return null;

    return {
      id: transactionId,
      merchantName: transaction.merchantName,
      amount: transaction.amount,
      currency: transaction.currency,
      transactionAt: transaction.transactionAt,
      cardLast4: transaction.cardLast4,
      decisionConfidence: typeof candidate.decisionConfidence === 'number'
        ? candidate.decisionConfidence
        : null,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
