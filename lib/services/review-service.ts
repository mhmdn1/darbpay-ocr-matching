import prisma from '@/lib/prisma';
import type { Prisma } from '@/lib/generated/prisma/client';
import { log } from '@/lib/logger';
import { serializeStatusDetails, STATUS_REASON } from '@/lib/services/document-status-reason';
import { MATCHER_VERSION, normalizeMerchant } from '@/lib/services/transaction-matcher';
import type { RejectionReason } from '@/lib/domain/review-reasons';

const CONFIRMED_STATUSES = ['CONFIRMED', 'AUTO_CONFIRMED'] as const;

export interface ReviewResult {
  matchId: number;
  documentId: number;
  documentStatus: string;
  matchStatus: string;
}

/**
 * Confirm a candidate match inside a single interactive transaction.
 *
 * - Idempotent for a match already in CONFIRMED (same reviewer intent).
 * - Guards against races: the CANDIDATE → CONFIRMED transition uses an
 *   `updateMany` with a status predicate; if another request already
 *   decided the match, the update count is 0 and we surface the current
 *   state instead of overwriting it.
 * - Enforces one CONFIRMED/AUTO_CONFIRMED match per transaction. If the
 *   transaction already has one, we fail rather than silently reject the
 *   previous match — the reviewer sees the collision and can act.
 */
export async function confirmMatchTx(matchId: number, decidedBy: string): Promise<ReviewResult> {
  return prisma.$transaction(async (tx) => {
    const match = await tx.documentMatch.findUnique({
      where: { id: matchId },
      include: { document: true, transaction: true },
    });
    if (!match) throw new Error('Match not found');

    // Idempotent replay: already confirmed by an earlier request.
    if (match.status === 'CONFIRMED' || match.status === 'AUTO_CONFIRMED') {
      return {
        matchId: match.id,
        documentId: match.documentId,
        documentStatus: match.document.status,
        matchStatus: match.status,
      };
    }

    if (match.status === 'REJECTED') {
      throw new Error('Match has already been rejected');
    }

    // Enforce the one-confirmed-doc-per-transaction rule at the data layer.
    const alreadyConfirmedOnTx = await tx.documentMatch.findFirst({
      where: {
        transactionId: match.transactionId,
        status: { in: [...CONFIRMED_STATUSES] },
        NOT: { id: match.id },
      },
    });
    if (alreadyConfirmedOnTx) {
      throw new Error(
        `Transaction ${match.transactionId} already has a confirmed document (match ${alreadyConfirmedOnTx.id}). ` +
          'Reject the existing match first if this is a correction.',
      );
    }

    const snapshot = await captureDecisionSnapshot(tx, match.documentId);

    // Race-safe confirm: only transition if still CANDIDATE.
    const now = new Date();
    const confirmed = await tx.documentMatch.updateMany({
      where: { id: match.id, status: 'CANDIDATE' },
      data: { status: 'CONFIRMED', decidedBy, decidedAt: now },
    });
    if (confirmed.count === 0) {
      throw new Error('Match state changed under you; refresh and try again');
    }

    // Auto-reject sibling candidates on the same document (they lost).
    await tx.documentMatch.updateMany({
      where: {
        documentId: match.documentId,
        status: 'CANDIDATE',
        NOT: { id: match.id },
      },
      data: { status: 'REJECTED', decidedBy: 'system', decidedAt: now },
    });

    await tx.document.update({
      where: { id: match.documentId },
      data: {
        status: 'MATCHED',
        statusReason: STATUS_REASON.HUMAN_CONFIRMED,
        statusDetails: serializeStatusDetails({ topScore: match.decisionConfidence }),
      },
    });

    await tx.reviewDecisionEvent.create({
      data: {
        documentId: match.documentId,
        matchId: match.id,
        transactionId: match.transactionId,
        action: 'CONFIRM',
        reason: 'REVIEWER_SELECTED',
        decidedBy,
        matcherVersion: match.matcherVersion || MATCHER_VERSION,
        documentSnapshot: snapshot.documentSnapshot,
        candidateSnapshot: snapshot.candidateSnapshot,
      },
    });

    await learnMerchantAlias(tx, {
      clientId: match.transaction.clientId,
      documentMerchant: match.document.merchantName,
      canonicalMerchant: match.transaction.merchantName,
      confirmedAt: now,
    });

    log.info('match confirmed', { matchId, documentId: match.documentId });
    return {
      matchId: match.id,
      documentId: match.documentId,
      documentStatus: 'MATCHED',
      matchStatus: 'CONFIRMED',
    };
  });
}

/**
 * Reject a candidate match. If the document has no remaining CANDIDATE
 * matches after this rejection, its status flips to UNMATCHED.
 */
export async function rejectMatchTx(
  matchId: number,
  decidedBy: string,
  reason: RejectionReason = 'NOT_SAME_PURCHASE',
): Promise<ReviewResult> {
  return prisma.$transaction(async (tx) => {
    const match = await tx.documentMatch.findUnique({
      where: { id: matchId },
      include: { document: true },
    });
    if (!match) throw new Error('Match not found');

    if (match.status === 'REJECTED') {
      return {
        matchId: match.id,
        documentId: match.documentId,
        documentStatus: match.document.status,
        matchStatus: match.status,
      };
    }

    if (match.status === 'CONFIRMED' || match.status === 'AUTO_CONFIRMED') {
      throw new Error('Cannot reject an already-confirmed match');
    }

    const snapshot = await captureDecisionSnapshot(tx, match.documentId);

    const now = new Date();
    const rejected = await tx.documentMatch.updateMany({
      where: { id: match.id, status: 'CANDIDATE' },
      data: { status: 'REJECTED', decidedBy, decidedAt: now },
    });
    if (rejected.count === 0) {
      throw new Error('Match state changed under you; refresh and try again');
    }

    const remaining = await tx.documentMatch.count({
      where: { documentId: match.documentId, status: 'CANDIDATE' },
    });

    let documentStatus = 'NEEDS_REVIEW';
    if (remaining === 0) {
      documentStatus = 'UNMATCHED';
      const rejectedCandidateCount = await tx.documentMatch.count({
        where: { documentId: match.documentId, status: 'REJECTED' },
      });
      await tx.document.update({
        where: { id: match.documentId },
        data: {
          status: 'UNMATCHED',
          statusReason: STATUS_REASON.ALL_CANDIDATES_REJECTED,
          statusDetails: serializeStatusDetails({ rejectedCandidateCount, remainingCandidateCount: 0 }),
        },
      });
    }


    await tx.reviewDecisionEvent.create({
      data: {
        documentId: match.documentId,
        matchId: match.id,
        transactionId: match.transactionId,
        action: 'REJECT',
        reason,
        decidedBy,
        matcherVersion: match.matcherVersion || MATCHER_VERSION,
        documentSnapshot: snapshot.documentSnapshot,
        candidateSnapshot: snapshot.candidateSnapshot,
      },
    });

    log.info('match rejected', { matchId, documentId: match.documentId, remaining });
    return {
      matchId: match.id,
      documentId: match.documentId,
      documentStatus,
      matchStatus: 'REJECTED',
    };
  });
}

async function captureDecisionSnapshot(tx: Prisma.TransactionClient, documentId: number) {
  const document = await tx.document.findUniqueOrThrow({
    where: { id: documentId },
    include: {
      matches: {
        include: { transaction: true },
        orderBy: [{ rank: 'asc' }, { id: 'asc' }],
      },
    },
  });
  const documentSnapshot = JSON.stringify({
    documentId: document.id,
    source: document.source,
    documentType: document.documentType,
    merchantName: document.merchantName,
    totalAmount: document.totalAmount,
    currency: document.currency,
    documentDate: document.documentDate?.toISOString() ?? null,
    cardLast4: document.cardLast4,
    vatNumber: document.vatNumber,
    invoiceNumber: document.invoiceNumber,
    authorizationCode: document.authorizationCode,
    fieldConfidences: document.fieldConfidences,
    extractionConfidence: document.extractionConfidence,
  });
  const candidateSnapshot = JSON.stringify(document.matches.map((candidate) => ({
    matchId: candidate.id,
    transactionId: candidate.transactionId,
    rank: candidate.rank,
    similarity: candidate.confidence,
    decisionConfidence: candidate.decisionConfidence,
    evidenceCoverage: candidate.evidenceCoverage,
    signals: candidate.signals,
    contradictions: candidate.contradictions,
    status: candidate.status,
    matcherVersion: candidate.matcherVersion,
    transaction: {
      merchantName: candidate.transaction.merchantName,
      amount: candidate.transaction.amount,
      currency: candidate.transaction.currency,
      transactionAt: candidate.transaction.transactionAt.toISOString(),
      cardLast4: candidate.transaction.cardLast4,
    },
  })));
  return { documentSnapshot, candidateSnapshot };
}

async function learnMerchantAlias(
  tx: Prisma.TransactionClient,
  input: {
    clientId: number;
    documentMerchant: string | null;
    canonicalMerchant: string;
    confirmedAt: Date;
  },
): Promise<void> {
  if (!input.documentMerchant) return;
  const normalizedAlias = normalizeMerchant(input.documentMerchant);
  const canonicalNormalized = normalizeMerchant(input.canonicalMerchant);
  if (!normalizedAlias || !canonicalNormalized) return;

  await tx.merchantAlias.upsert({
    where: {
      clientId_normalizedAlias_canonicalNormalized: {
        clientId: input.clientId,
        normalizedAlias,
        canonicalNormalized,
      },
    },
    update: {
      alias: input.documentMerchant,
      canonicalMerchantName: input.canonicalMerchant,
      confirmationCount: { increment: 1 },
      lastConfirmedAt: input.confirmedAt,
    },
    create: {
      clientId: input.clientId,
      alias: input.documentMerchant,
      normalizedAlias,
      canonicalMerchantName: input.canonicalMerchant,
      canonicalNormalized,
      lastConfirmedAt: input.confirmedAt,
    },
  });
}
