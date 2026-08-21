import prisma from '@/lib/prisma';
import { log } from '@/lib/logger';
import { serializeStatusDetails, STATUS_REASON } from '@/lib/services/document-status-reason';

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
    const match = await tx.documentMatch.findUnique({ where: { id: matchId } });
    if (!match) throw new Error('Match not found');

    // Idempotent replay: already confirmed by an earlier request.
    if (match.status === 'CONFIRMED' || match.status === 'AUTO_CONFIRMED') {
      const doc = await tx.document.findUnique({ where: { id: match.documentId } });
      return {
        matchId: match.id,
        documentId: match.documentId,
        documentStatus: doc?.status ?? 'MATCHED',
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
        statusDetails: serializeStatusDetails({ topScore: match.confidence }),
      },
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
export async function rejectMatchTx(matchId: number, decidedBy: string): Promise<ReviewResult> {
  return prisma.$transaction(async (tx) => {
    const match = await tx.documentMatch.findUnique({ where: { id: matchId } });
    if (!match) throw new Error('Match not found');

    if (match.status === 'REJECTED') {
      const doc = await tx.document.findUnique({ where: { id: match.documentId } });
      return {
        matchId: match.id,
        documentId: match.documentId,
        documentStatus: doc?.status ?? 'UNMATCHED',
        matchStatus: match.status,
      };
    }

    if (match.status === 'CONFIRMED' || match.status === 'AUTO_CONFIRMED') {
      throw new Error('Cannot reject an already-confirmed match');
    }

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

    log.info('match rejected', { matchId, documentId: match.documentId, remaining });
    return {
      matchId: match.id,
      documentId: match.documentId,
      documentStatus,
      matchStatus: 'REJECTED',
    };
  });
}
