import prisma from '@/lib/prisma';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import { MatchStatus } from '@/lib/generated/prisma/enums';
import {
  matchDocument,
  type CandidateTransaction,
  type MatchResult,
} from '@/lib/services/transaction-matcher';
import { log } from '@/lib/logger';
import { assignGlobally } from '@/lib/services/global-assignment';
import { addCandidateFrequencies, candidateDateWindow } from '@/lib/services/document-ingestion';
import { serializeStatusDetails, STATUS_REASON } from '@/lib/services/document-status-reason';

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

  const plans: Array<{ documentId: number; result: MatchResult }> = [];
  for (const doc of docs) {
    const candidates = await loadCandidatesForDocument(
      db, doc.source, doc.senderIdentifier, doc.documentDate?.toISOString() ?? null,
    );
    if (candidates.length === 0) {
      plans.push({ documentId: doc.id, result: { outcome: 'UNMATCHED', candidates: [] } });
      continue;
    }

    const result = matchDocument(
      {
        documentType: (doc.documentType as 'RECEIPT' | 'TAX_INVOICE' | 'UNKNOWN') ?? 'UNKNOWN',
        merchantName: doc.merchantName,
        totalAmount: doc.totalAmount,
        currency: doc.currency,
        documentDate: (doc.documentDate ?? doc.receivedAt).toISOString(),
        dateSource: doc.documentDate ? 'DOCUMENT' : 'RECEIVED_AT',
        cardLast4: doc.cardLast4,
        vatNumber: doc.vatNumber,
        invoiceNumber: doc.invoiceNumber,
        authorizationCode: doc.authorizationCode,
        fieldConfidences: parseFieldConfidences(doc.fieldConfidences),
      },
      candidates,
    );

    if (result.outcome === 'UNMATCHED') {
      plans.push({ documentId: doc.id, result });
      continue;
    }

    plans.push({ documentId: doc.id, result });
  }

  const assignments = assignGlobally(plans.flatMap((plan) =>
    plan.result.candidates.map((candidate) => ({
      documentId: plan.documentId,
      transactionId: candidate.transactionId,
      score: candidate.confidence,
    })),
  ));
  const assignedTransaction = new Map(assignments.map((assignment) => [assignment.documentId, assignment.transactionId]));
  const results: RematchOutcome[] = [];

  for (const plan of plans) {
    let result = plan.result;
    if (result.outcome === 'UNMATCHED') {
      await db.document.update({
        where: { id: plan.documentId },
        data: {
          statusReason: result.diagnostics?.reason ?? STATUS_REASON.NO_SCOPED_TRANSACTIONS,
          statusDetails: serializeStatusDetails(result.diagnostics),
        },
      });
      results.push({ documentId: plan.documentId, outcome: 'UNMATCHED', candidates: 0 });
      continue;
    }

    const assignedId = assignedTransaction.get(plan.documentId);
    if (assignedId == null) {
      // A stronger document won every shared transaction. Keep this one human-
      // reviewable instead of greedily auto-confirming a duplicate claim.
      result = { ...result, outcome: 'NEEDS_REVIEW' };
    } else if (assignedId !== result.candidates[0].transactionId) {
      const assigned = result.candidates.find((candidate) => candidate.transactionId === assignedId)!;
      result = {
        outcome: 'NEEDS_REVIEW',
        candidates: [assigned, ...result.candidates.filter((candidate) => candidate.transactionId !== assignedId)],
      };
    }

    const isAuto = result.outcome === 'AUTO_MATCHED';
    await db.$transaction(async (tx) => {
      if (isAuto) {
        await tx.documentMatch.create({
          data: {
            documentId: plan.documentId,
            transactionId: result.candidates[0].transactionId,
            confidence: result.candidates[0].confidence,
            signals: JSON.stringify(result.candidates[0].signals),
            evidenceCoverage: result.candidates[0].evidenceCoverage,
            contradictions: JSON.stringify(result.candidates[0].contradictions),
            rank: 1,
            status: 'AUTO_CONFIRMED',
            decidedBy: 'system-rematch',
            decidedAt: new Date(),
          },
        });
        await tx.document.update({
          where: { id: plan.documentId },
          data: {
            status: 'MATCHED',
            statusReason: STATUS_REASON.AUTO_MATCHED_AFTER_REMATCH,
            statusDetails: null,
          },
        });
      } else {
        for (const [index, c] of result.candidates.entries()) {
          await tx.documentMatch.create({
            data: {
              documentId: plan.documentId,
              transactionId: c.transactionId,
              confidence: c.confidence,
              signals: JSON.stringify(c.signals),
              evidenceCoverage: c.evidenceCoverage,
              contradictions: JSON.stringify(c.contradictions),
              rank: index + 1,
              status: 'CANDIDATE',
            },
          });
        }
        await tx.document.update({
          where: { id: plan.documentId },
          data: {
            status: 'NEEDS_REVIEW',
            reviewReason: STATUS_REASON.REMATCH_REVIEW,
            statusReason: STATUS_REASON.REMATCH_REVIEW,
            statusDetails: serializeStatusDetails({
              scopedCandidateCount: result.candidates.length,
              displayedCandidateCount: result.candidates.length,
              topScore: result.candidates[0]?.confidence ?? null,
            }),
          },
        });
      }
    });

    log.info('rematch promoted document', {
      documentId: plan.documentId,
      outcome: result.outcome,
      candidates: result.candidates.length,
    });
    results.push({ documentId: plan.documentId, outcome: result.outcome, candidates: result.candidates.length });
  }

  return results;
}

async function loadCandidatesForDocument(
  db: PrismaClient,
  source: string,
  senderIdentifier: string,
  documentDate: string | null,
): Promise<CandidateTransaction[]> {
  const dateWindow = candidateDateWindow(documentDate);
  const confirmedStatuses: MatchStatus[] = [MatchStatus.CONFIRMED, MatchStatus.AUTO_CONFIRMED];
  const includeConfirmed = {
    documents: { where: { status: { in: confirmedStatuses } }, select: { id: true } },
  };

  if (source === 'WHATSAPP') {
    const txs = await db.transaction.findMany({
      where: { driverPhone: senderIdentifier, ...(dateWindow ? { transactionAt: dateWindow } : {}) },
      include: includeConfirmed,
    });
    return addCandidateFrequencies(txs.map((tx) => ({
      id: tx.id,
      cardLast4: tx.cardLast4,
      merchantName: tx.merchantName,
      amount: tx.amount,
      currency: tx.currency,
      transactionAt: tx.transactionAt,
      hasConfirmedDocument: tx.documents.length > 0,
      merchantVatNumber: tx.merchantVatNumber,
      invoiceNumber: tx.invoiceNumber,
      authorizationCode: tx.authorizationCode,
      merchantCategory: tx.merchantCategory,
      merchantCity: tx.merchantCity,
    })));
  }

  const senderRow = await db.clientEmail.findUnique({ where: { email: senderIdentifier.toLowerCase() } });
  if (!senderRow) return [];
  const txs = await db.transaction.findMany({
    where: { clientId: senderRow.clientId, ...(dateWindow ? { transactionAt: dateWindow } : {}) },
    include: includeConfirmed,
  });
  return addCandidateFrequencies(txs.map((tx) => ({
    id: tx.id,
    cardLast4: tx.cardLast4,
    merchantName: tx.merchantName,
    amount: tx.amount,
    currency: tx.currency,
    transactionAt: tx.transactionAt,
    hasConfirmedDocument: tx.documents.length > 0,
    merchantVatNumber: tx.merchantVatNumber,
    invoiceNumber: tx.invoiceNumber,
    authorizationCode: tx.authorizationCode,
    merchantCategory: tx.merchantCategory,
    merchantCity: tx.merchantCity,
  })));
}

function parseFieldConfidences(value: string | null): Record<string, number> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, number> : undefined;
  } catch { return undefined; }
}
