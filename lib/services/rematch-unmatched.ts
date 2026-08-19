import prisma from '@/lib/prisma';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { MatchStatus } from '@/lib/generated/prisma/enums';
import {
  matchDocument,
  type CandidateTransaction,
  type MatchResult,
} from '@/lib/services/transaction-matcher';
import { log } from '@/lib/logger';

export interface RematchScope {
  clientId?: number;
  driverPhone?: string;
}

export interface RematchOutcome {
  documentId: number;
  outcome: MatchResult['outcome'];
  candidates: number;
}

/**
 * Re-run the matcher over UNMATCHED documents when new candidate
 * transactions become available. Scope can be a client (email side) or a
 * driver phone (WhatsApp side); pass both for broadest coverage.
 *
 * Handles the "document arrived before its transaction" case cheaply:
 * you call this after seeding a transaction and any previously orphaned
 * document that now has a match will be promoted to MATCHED or
 * NEEDS_REVIEW automatically.
 */
export async function rematchUnmatched(
  scope: RematchScope,
  db: PrismaClient = prisma,
): Promise<RematchOutcome[]> {
  const senderIdentifiers = new Set<string>();

  if (scope.clientId != null) {
    const emails = await db.clientEmail.findMany({ where: { clientId: scope.clientId } });
    for (const e of emails) senderIdentifiers.add(e.email);
  }
  if (scope.driverPhone) senderIdentifiers.add(scope.driverPhone);

  if (senderIdentifiers.size === 0) return [];

  const docs = await db.document.findMany({
    where: {
      status: 'UNMATCHED',
      senderIdentifier: { in: Array.from(senderIdentifiers) },
    },
  });

  const results: RematchOutcome[] = [];

  for (const doc of docs) {
    const candidates = await loadCandidatesForDocument(db, doc.source, doc.senderIdentifier);
    if (candidates.length === 0) {
      results.push({ documentId: doc.id, outcome: 'UNMATCHED', candidates: 0 });
      continue;
    }

    const result = matchDocument(
      {
        documentType: (doc.documentType as 'RECEIPT' | 'TAX_INVOICE' | 'UNKNOWN') ?? 'UNKNOWN',
        merchantName: doc.merchantName,
        totalAmount: doc.totalAmount,
        currency: doc.currency,
        documentDate: doc.documentDate?.toISOString() ?? null,
        cardLast4: doc.cardLast4,
      },
      candidates,
    );

    if (result.outcome === 'UNMATCHED') {
      results.push({ documentId: doc.id, outcome: 'UNMATCHED', candidates: 0 });
      continue;
    }

    const isAuto = result.outcome === 'AUTO_MATCHED';
    await db.$transaction(async (tx) => {
      if (isAuto) {
        await tx.documentMatch.create({
          data: {
            documentId: doc.id,
            transactionId: result.candidates[0].transactionId,
            confidence: result.candidates[0].confidence,
            signals: JSON.stringify(result.candidates[0].signals),
            status: 'AUTO_CONFIRMED',
            decidedBy: 'system-rematch',
            decidedAt: new Date(),
          },
        });
        await tx.document.update({ where: { id: doc.id }, data: { status: 'MATCHED' } });
      } else {
        for (const c of result.candidates) {
          await tx.documentMatch.create({
            data: {
              documentId: doc.id,
              transactionId: c.transactionId,
              confidence: c.confidence,
              signals: JSON.stringify(c.signals),
              status: 'CANDIDATE',
            },
          });
        }
        await tx.document.update({ where: { id: doc.id }, data: { status: 'NEEDS_REVIEW' } });
      }
    });

    log.info('rematch promoted document', {
      documentId: doc.id,
      outcome: result.outcome,
      candidates: result.candidates.length,
    });
    results.push({ documentId: doc.id, outcome: result.outcome, candidates: result.candidates.length });
  }

  return results;
}

async function loadCandidatesForDocument(
  db: PrismaClient,
  source: string,
  senderIdentifier: string,
): Promise<CandidateTransaction[]> {
  const confirmedStatuses: MatchStatus[] = [MatchStatus.CONFIRMED, MatchStatus.AUTO_CONFIRMED];
  const includeConfirmed = {
    documents: { where: { status: { in: confirmedStatuses } }, select: { id: true } },
  };

  if (source === 'WHATSAPP') {
    const txs = await db.transaction.findMany({
      where: { driverPhone: senderIdentifier },
      include: includeConfirmed,
    });
    return txs.map((tx) => ({
      id: tx.id,
      cardLast4: tx.cardLast4,
      merchantName: tx.merchantName,
      amount: tx.amount,
      currency: tx.currency,
      transactionAt: tx.transactionAt,
      hasConfirmedDocument: tx.documents.length > 0,
    }));
  }

  const senderRow = await db.clientEmail.findUnique({ where: { email: senderIdentifier.toLowerCase() } });
  if (!senderRow) return [];
  const txs = await db.transaction.findMany({
    where: { clientId: senderRow.clientId },
    include: includeConfirmed,
  });
  return txs.map((tx) => ({
    id: tx.id,
    cardLast4: tx.cardLast4,
    merchantName: tx.merchantName,
    amount: tx.amount,
    currency: tx.currency,
    transactionAt: tx.transactionAt,
    hasConfirmedDocument: tx.documents.length > 0,
  }));
}
