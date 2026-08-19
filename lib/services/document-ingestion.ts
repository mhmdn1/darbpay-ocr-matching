import { createHash } from 'node:crypto';
import prisma from '@/lib/prisma';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';
import {
  matchDocument,
  type CandidateTransaction,
  type MatchResult,
} from '@/lib/services/transaction-matcher';
import { log } from '@/lib/logger';

export type IngestionSource = 'EMAIL' | 'WHATSAPP';

export interface IngestionInput {
  source: IngestionSource;
  externalId: string;       // messageId (email) or wamid (WhatsApp)
  senderIdentifier: string; // sender email or E.164 phone
  fileBytes: Buffer;
  mimeType: string;
  receivedAt?: Date;
}

export interface IngestionResult {
  documentId: number;
  status: DocumentStatus;
  outcome: 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'UNMATCHED' | 'FAILED' | 'DUPLICATE';
  candidateCount: number;
  errorMessage?: string;
}

type DocumentStatus = 'RECEIVED' | 'EXTRACTED' | 'MATCHED' | 'NEEDS_REVIEW' | 'UNMATCHED' | 'FAILED';

// If extraction produced this little useful data we skip matching and mark FAILED.
const MIN_EXTRACTION_CONFIDENCE = 0.3;

export interface IngestionDependencies {
  prisma?: PrismaClient;
  extractor: DocumentExtractor;
}

/**
 * Ingest a single document from a webhook.
 *
 * Guarantees:
 * - Never throws. All errors are caught and translated to a FAILED document
 *   so the webhook can respond 200 without losing the message.
 * - Idempotent on (externalId, contentHash). Redelivery returns the existing
 *   document rather than creating a second row.
 * - Extractor sits behind DocumentExtractor so a real OCR provider can be
 *   swapped in at wiring time.
 */
export async function ingestDocument(
  input: IngestionInput,
  deps: IngestionDependencies,
): Promise<IngestionResult> {
  const db = deps.prisma ?? prisma;
  const contentHash = sha256(input.fileBytes);
  let documentId: number | null = null;

  try {

  // ── 1. Dedupe ────────────────────────────────────────────────────────────
  const existing = await db.document.findFirst({
    where: {
      OR: [{ externalId: input.externalId }, { contentHash }],
    },
    include: { _count: { select: { matches: true } } },
  });
  if (existing) {
    log.info('ingestion dedupe hit', {
      documentId: existing.id,
      externalId: input.externalId,
      byHash: existing.contentHash === contentHash && existing.externalId !== input.externalId,
    });
    return {
      documentId: existing.id,
      status: existing.status as DocumentStatus,
      outcome: 'DUPLICATE',
      candidateCount: existing._count.matches,
    };
  }

  // ── 2. Create Document row (RECEIVED) ────────────────────────────────────
  const doc = await db.document.create({
    data: {
      source: input.source,
      externalId: input.externalId,
      contentHash,
      senderIdentifier: input.senderIdentifier,
      status: 'RECEIVED',
      receivedAt: input.receivedAt ?? new Date(),
    },
  });
  documentId = doc.id;

  // ── 3. Extract ───────────────────────────────────────────────────────────
  let extracted: ExtractedDocument;
  try {
    extracted = await deps.extractor.extract(input.fileBytes, input.mimeType);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('extraction threw', { documentId: doc.id, message });
    await db.document.update({
      where: { id: doc.id },
      data: { status: 'FAILED', errorMessage: `extraction: ${message}` },
    });
    return {
      documentId: doc.id,
      status: 'FAILED',
      outcome: 'FAILED',
      candidateCount: 0,
      errorMessage: message,
    };
  }

  // Persist extraction results (even when confidence is too low to match —
  // the reviewer may still find them useful).
  await db.document.update({
    where: { id: doc.id },
    data: {
      status: 'EXTRACTED',
      documentType: extracted.documentType,
      merchantName: extracted.merchantName,
      vatNumber: extracted.vatNumber,
      totalAmount: extracted.totalAmount,
      currency: extracted.currency,
      documentDate: extracted.documentDate ? new Date(extracted.documentDate) : null,
      cardLast4: extracted.cardLast4,
      invoiceNumber: extracted.invoiceNumber,
      rawText: extracted.rawText,
      extractionConfidence: extracted.extractionConfidence,
    },
  });

  if (
    extracted.documentType === 'UNKNOWN' ||
    extracted.extractionConfidence < MIN_EXTRACTION_CONFIDENCE ||
    extracted.totalAmount == null
  ) {
    await db.document.update({
      where: { id: doc.id },
      data: {
        status: 'FAILED',
        errorMessage: `low-quality extraction (confidence=${extracted.extractionConfidence})`,
      },
    });
    return {
      documentId: doc.id,
      status: 'FAILED',
      outcome: 'FAILED',
      candidateCount: 0,
      errorMessage: 'low-quality extraction',
    };
  }

  // ── 4. Load scoped candidate transactions ─────────────────────────────────
  let candidates: CandidateTransaction[];
  try {
    candidates = await loadCandidates(db, input.source, input.senderIdentifier);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('candidate load failed', { documentId: doc.id, message });
    await db.document.update({
      where: { id: doc.id },
      data: { status: 'FAILED', errorMessage: `scoping: ${message}` },
    });
    return {
      documentId: doc.id,
      status: 'FAILED',
      outcome: 'FAILED',
      candidateCount: 0,
      errorMessage: message,
    };
  }

  // ── 5. Match ─────────────────────────────────────────────────────────────
  const result = matchDocument(
    {
      documentType: extracted.documentType,
      merchantName: extracted.merchantName,
      totalAmount: extracted.totalAmount,
      currency: extracted.currency,
      documentDate: extracted.documentDate,
      cardLast4: extracted.cardLast4,
    },
    candidates,
  );

  return await persistMatchResult(db, doc.id, result);
  } catch (err) {
    // The unique constraints are the source of truth for idempotency. This
    // handles concurrent redeliveries that both pass the optimistic pre-check.
    if (isUniqueConstraintError(err)) {
      const winner = await db.document.findFirst({
        where: { OR: [{ externalId: input.externalId }, { contentHash }] },
        include: { _count: { select: { matches: true } } },
      });
      if (winner) {
        return {
          documentId: winner.id,
          status: winner.status as DocumentStatus,
          outcome: 'DUPLICATE',
          candidateCount: winner._count.matches,
        };
      }
    }

    const message = err instanceof Error ? err.message : String(err);
    log.error('document ingestion failed', { documentId, externalId: input.externalId, message });

    if (documentId != null) {
      try {
        await db.document.update({
          where: { id: documentId },
          data: { status: 'FAILED', errorMessage: `pipeline: ${message}` },
        });
      } catch (markFailedError) {
        log.error('failed to mark document as FAILED', {
          documentId,
          message: markFailedError instanceof Error ? markFailedError.message : String(markFailedError),
        });
      }
      return {
        documentId,
        status: 'FAILED',
        outcome: 'FAILED',
        candidateCount: 0,
        errorMessage: message,
      };
    }

    // A database outage before Document creation cannot be represented as a
    // persisted terminal state; let the webhook boundary report the item error.
    throw err;
  }
}

async function loadCandidates(
  db: PrismaClient,
  source: IngestionSource,
  senderIdentifier: string,
): Promise<CandidateTransaction[]> {
  if (source === 'WHATSAPP') {
    const normalized = normalizePhone(senderIdentifier);
    const txs = await db.transaction.findMany({
      where: { driverPhone: normalized },
      include: {
        documents: { where: { status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] } }, select: { id: true } },
      },
    });
    return txs.map(toCandidate);
  }

  // EMAIL: look up sender → client → transactions
  const senderRow = await db.clientEmail.findUnique({ where: { email: senderIdentifier.toLowerCase() } });
  if (!senderRow) return [];
  const txs = await db.transaction.findMany({
    where: { clientId: senderRow.clientId },
    include: {
      documents: { where: { status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] } }, select: { id: true } },
    },
  });
  return txs.map(toCandidate);
}

type TxWithConfirmed = Awaited<ReturnType<PrismaClient['transaction']['findMany']>>[number] & {
  documents: Array<{ id: number }>;
};

function toCandidate(tx: TxWithConfirmed): CandidateTransaction {
  return {
    id: tx.id,
    cardLast4: tx.cardLast4,
    merchantName: tx.merchantName,
    amount: tx.amount,
    currency: tx.currency,
    transactionAt: tx.transactionAt,
    hasConfirmedDocument: tx.documents.length > 0,
  };
}

async function persistMatchResult(
  db: PrismaClient,
  documentId: number,
  result: MatchResult,
): Promise<IngestionResult> {
  if (result.outcome === 'UNMATCHED') {
    await db.document.update({ where: { id: documentId }, data: { status: 'UNMATCHED' } });
    return { documentId, status: 'UNMATCHED', outcome: 'UNMATCHED', candidateCount: 0 };
  }

  const isAuto = result.outcome === 'AUTO_MATCHED';
  const topCandidate = result.candidates[0];

  await db.$transaction(async (tx) => {
    if (isAuto) {
      // Persist only the winning match, as AUTO_CONFIRMED.
      await tx.documentMatch.create({
        data: {
          documentId,
          transactionId: topCandidate.transactionId,
          confidence: topCandidate.confidence,
          signals: JSON.stringify(topCandidate.signals),
          status: 'AUTO_CONFIRMED',
          decidedBy: 'system',
          decidedAt: new Date(),
        },
      });
      await tx.document.update({ where: { id: documentId }, data: { status: 'MATCHED' } });
    } else {
      // NEEDS_REVIEW: persist all ranked candidates as CANDIDATE for the review UI.
      for (const c of result.candidates) {
        await tx.documentMatch.create({
          data: {
            documentId,
            transactionId: c.transactionId,
            confidence: c.confidence,
            signals: JSON.stringify(c.signals),
            status: 'CANDIDATE',
          },
        });
      }
      await tx.document.update({ where: { id: documentId }, data: { status: 'NEEDS_REVIEW' } });
    }
  });

  return {
    documentId,
    status: isAuto ? 'MATCHED' : 'NEEDS_REVIEW',
    outcome: result.outcome,
    candidateCount: result.candidates.length,
  };
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * WhatsApp sends "966551234567" (no +). Seed data stores E.164 with +.
 * Normalize both sides to +<digits> when comparing.
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length > 0 ? `+${digits}` : phone;
}

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
