import { createHash } from 'node:crypto';
import prisma from '@/lib/prisma';
import type { PrismaClient } from '@/lib/generated/prisma/client';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';
import { enrichWithZatcaQr } from '@/lib/extraction/zatca-qr';
import {
  matchDocument,
  normalizeMerchant,
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
  extractionTimeoutMs?: number;
}

/**
 * Ingest a single document from a webhook.
 *
 * Guarantees:
 * - Never throws. All errors are caught and translated to a FAILED document
 *   so the webhook can respond 200 without losing the message.
 * - Idempotent on provider ID, tenant-scoped content hash, and strong semantic
 *   invoice identity. Redelivery returns the existing document.
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
  let semanticFingerprint: string | null = null;

  try {
  const ownerKey = await resolveOwnerKey(db, input.source, input.senderIdentifier);

  // ── 1. Dedupe ────────────────────────────────────────────────────────────
  const existing = await db.document.findFirst({
    where: {
      OR: [
        { source: input.source, externalId: input.externalId },
        { ownerKey, contentHash },
      ],
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
      ownerKey,
      senderIdentifier: input.senderIdentifier,
      status: 'RECEIVED',
      receivedAt: input.receivedAt ?? new Date(),
    },
  });
  documentId = doc.id;

  // ── 3. Extract ───────────────────────────────────────────────────────────
  let extracted: ExtractedDocument;
  try {
    extracted = enrichWithZatcaQr(await withTimeout(
      deps.extractor.extract(input.fileBytes, input.mimeType),
      deps.extractionTimeoutMs ?? 15_000,
      'extraction timed out',
    ));
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

  semanticFingerprint = buildSemanticFingerprint(extracted);
  log.info('document extracted', {
    documentId: doc.id,
    documentType: extracted.documentType,
    extractionConfidence: extracted.extractionConfidence,
    hasPrintedDate: Boolean(extracted.documentDate),
    hasStrongIdentifier: Boolean(extracted.authorizationCode || extracted.invoiceNumber || extracted.vatNumber),
    enrichedByZatcaQr: Boolean(extracted.qrPayload),
  });
  if (semanticFingerprint) {
    const semanticDuplicate = await db.document.findFirst({
      where: { ownerKey, semanticFingerprint, id: { not: doc.id } },
      include: { _count: { select: { matches: true } } },
    });
    if (semanticDuplicate) {
      // This placeholder belongs to the current call and has no matches yet.
      await db.document.delete({ where: { id: doc.id } });
      documentId = null;
      return {
        documentId: semanticDuplicate.id,
        status: semanticDuplicate.status as DocumentStatus,
        outcome: 'DUPLICATE',
        candidateCount: semanticDuplicate._count.matches,
      };
    }
  }

  // Persist extraction results (even when confidence is too low to match —
  // the reviewer may still find them useful).
  await db.document.update({
    where: { id: doc.id },
    data: {
      status: 'EXTRACTED',
      semanticFingerprint,
      documentType: extracted.documentType,
      merchantName: extracted.merchantName,
      vatNumber: extracted.vatNumber,
      totalAmount: extracted.totalAmount,
      currency: extracted.currency,
      documentDate: extracted.documentDate ? new Date(extracted.documentDate) : null,
      cardLast4: extracted.cardLast4,
      invoiceNumber: extracted.invoiceNumber,
      authorizationCode: extracted.authorizationCode,
      fieldConfidences: extracted.fieldConfidences ? JSON.stringify(extracted.fieldConfidences) : null,
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
    candidates = await loadCandidates(db, input.source, input.senderIdentifier, extracted.documentDate);
    log.info('candidate block loaded', {
      documentId: doc.id,
      candidateCount: candidates.length,
      usedDateBlock: Boolean(extracted.documentDate),
    });
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
      documentDate: extracted.documentDate ?? doc.receivedAt.toISOString(),
      dateSource: extracted.documentDate ? 'DOCUMENT' : 'RECEIVED_AT',
      cardLast4: extracted.cardLast4,
      vatNumber: extracted.vatNumber,
      invoiceNumber: extracted.invoiceNumber,
      authorizationCode: extracted.authorizationCode,
      fieldConfidences: extracted.fieldConfidences,
    },
    candidates,
  );

  return await persistMatchResult(db, doc.id, result);
  } catch (err) {
    // The unique constraints are the source of truth for idempotency. This
    // handles concurrent redeliveries that both pass the optimistic pre-check.
    if (isUniqueConstraintError(err)) {
      const winner = await db.document.findFirst({
        where: {
          OR: [
            { source: input.source, externalId: input.externalId },
            { ownerKey: await resolveOwnerKey(db, input.source, input.senderIdentifier), contentHash },
            ...(semanticFingerprint ? [{
              ownerKey: await resolveOwnerKey(db, input.source, input.senderIdentifier),
              semanticFingerprint,
            }] : []),
          ],
        },
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
  documentDate: string | null,
): Promise<CandidateTransaction[]> {
  const dateWindow = candidateDateWindow(documentDate);
  if (source === 'WHATSAPP') {
    const normalized = normalizePhone(senderIdentifier);
    const txs = await db.transaction.findMany({
      where: { driverPhone: normalized, ...(dateWindow ? { transactionAt: dateWindow } : {}) },
      include: {
        documents: { where: { status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] } }, select: { id: true } },
      },
    });
    return addCandidateFrequencies(txs.map(toCandidate));
  }

  // EMAIL: look up sender → client → transactions
  const senderRow = await db.clientEmail.findUnique({ where: { email: senderIdentifier.toLowerCase() } });
  if (!senderRow) return [];
  const txs = await db.transaction.findMany({
    where: { clientId: senderRow.clientId, ...(dateWindow ? { transactionAt: dateWindow } : {}) },
    include: {
      documents: { where: { status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] } }, select: { id: true } },
    },
  });
  return addCandidateFrequencies(txs.map(toCandidate));
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
    merchantVatNumber: tx.merchantVatNumber,
    invoiceNumber: tx.invoiceNumber,
    authorizationCode: tx.authorizationCode,
    merchantCategory: tx.merchantCategory,
    merchantCity: tx.merchantCity,
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
  const isAuditSample = isAuto && shouldAuditAutoMatch(String(documentId));
  const persistAsAuto = isAuto && !isAuditSample;
  const topCandidate = result.candidates[0];
  log.info('matcher decision', {
    documentId,
    outcome: isAuditSample ? 'NEEDS_REVIEW' : result.outcome,
    candidateCount: result.candidates.length,
    topScore: topCandidate.confidence,
    evidenceCoverage: topCandidate.evidenceCoverage,
    contradictions: topCandidate.contradictions,
    auditSample: isAuditSample,
  });

  await db.$transaction(async (tx) => {
    if (persistAsAuto) {
      // Persist only the winning match, as AUTO_CONFIRMED.
      await tx.documentMatch.create({
        data: {
          documentId,
          transactionId: topCandidate.transactionId,
          confidence: topCandidate.confidence,
          signals: JSON.stringify(topCandidate.signals),
          evidenceCoverage: topCandidate.evidenceCoverage,
          contradictions: JSON.stringify(topCandidate.contradictions),
          rank: 1,
          status: 'AUTO_CONFIRMED',
          decidedBy: 'system',
          decidedAt: new Date(),
        },
      });
      await tx.document.update({ where: { id: documentId }, data: { status: 'MATCHED' } });
    } else {
      // NEEDS_REVIEW: persist all ranked candidates as CANDIDATE for the review UI.
      for (const [index, c] of result.candidates.entries()) {
        await tx.documentMatch.create({
          data: {
            documentId,
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
        where: { id: documentId },
        data: { status: 'NEEDS_REVIEW', reviewReason: isAuditSample ? 'AUTO_MATCH_AUDIT' : 'AMBIGUOUS_MATCH' },
      });
    }
  });

  return {
    documentId,
    status: persistAsAuto ? 'MATCHED' : 'NEEDS_REVIEW',
    outcome: persistAsAuto ? result.outcome : 'NEEDS_REVIEW',
    candidateCount: result.candidates.length,
  };
}

/** Restrict expensive scoring to a plausible temporal block. */
export function candidateDateWindow(documentDate: string | null): { gte: Date; lte: Date } | null {
  if (!documentDate) return null;
  const date = new Date(documentDate);
  if (!Number.isFinite(date.getTime())) return null;
  const radiusMs = 30 * 86_400_000;
  return { gte: new Date(date.getTime() - radiusMs), lte: new Date(date.getTime() + radiusMs) };
}

export function addCandidateFrequencies(candidates: CandidateTransaction[]): CandidateTransaction[] {
  const merchantCounts = new Map<string, number>();
  const amountCounts = new Map<number, number>();
  for (const candidate of candidates) {
    const merchant = normalizeMerchant(candidate.merchantName);
    merchantCounts.set(merchant, (merchantCounts.get(merchant) ?? 0) + 1);
    amountCounts.set(candidate.amount, (amountCounts.get(candidate.amount) ?? 0) + 1);
  }
  return candidates.map((candidate) => ({
    ...candidate,
    merchantFrequency: merchantCounts.get(normalizeMerchant(candidate.merchantName)) ?? 1,
    amountFrequency: amountCounts.get(candidate.amount) ?? 1,
  }));
}

async function resolveOwnerKey(
  db: PrismaClient,
  source: IngestionSource,
  senderIdentifier: string,
): Promise<string> {
  if (source === 'EMAIL') {
    const sender = await db.clientEmail.findUnique({ where: { email: senderIdentifier.toLowerCase() } });
    return sender ? `client:${sender.clientId}` : `email:${senderIdentifier.toLowerCase()}`;
  }

  const phone = normalizePhone(senderIdentifier);
  const owners = await db.transaction.findMany({
    where: { driverPhone: phone },
    distinct: ['clientId'],
    select: { clientId: true },
  });
  return owners.length === 1 ? `client:${owners[0].clientId}` : `phone:${phone}`;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Stable sampling gives finance a small, unbiased audit stream of auto-matches. */
export function shouldAuditAutoMatch(key: string, rate = 0.02): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const bucket = createHash('sha256').update(key).digest().readUInt32BE(0) / 0x1_0000_0000;
  return bucket < rate;
}

export function buildSemanticFingerprint(document: ExtractedDocument): string | null {
  const normalize = (value: string | null | undefined) => value?.trim().toUpperCase().replace(/[^A-Z0-9\u0600-\u06FF]/g, '') ?? '';
  let identity = '';
  if (document.authorizationCode) {
    identity = `AUTH:${normalize(document.authorizationCode)}`;
  } else if (document.invoiceNumber) {
    identity = `INVOICE:${normalize(document.vatNumber) || normalizeMerchant(document.merchantName ?? '')}:${normalize(document.invoiceNumber)}`;
  } else if (document.qrPayload) {
    identity = `QR:${document.qrPayload.trim()}`;
  }
  return identity ? createHash('sha256').update(identity).digest('hex') : null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
