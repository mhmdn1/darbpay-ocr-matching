import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import prisma from '@/lib/prisma';
import { candidateDateWindow, ingestDocument, sha256, shouldAuditAutoMatch } from '@/lib/services/document-ingestion';
import { MockExtractor } from '@/lib/extraction/mock-extractor';
import type { DocumentExtractor, ExtractedDocument } from '@/lib/extraction/types';
import { resetDatabase, seedBaseData, type SeededClient } from './helpers/db';

let extractor: DocumentExtractor;
const fixturesDir = join(process.cwd(), 'fixtures', 'documents');
let alRashed: SeededClient;
let najm: SeededClient;

beforeAll(async () => {
  extractor = await MockExtractor.create();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alRashed, najm } = await seedBaseData());
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loadFixture(name: string): Promise<Buffer> {
  return readFile(join(fixturesDir, name));
}

describe('ingestion — happy path via a known fixture', () => {
  test('email with the Alrajhi invoice → AUTO_MATCHED', async () => {
    const bytes = await loadFixture('alrajhi-auto-tax-invoice.txt');
    const r = await ingestDocument(
      {
        source: 'EMAIL',
        externalId: 'msg_1',
        senderIdentifier: alRashed.email,
        fileBytes: bytes,
        mimeType: 'application/pdf',
      },
      { extractor },
    );

    expect(r.outcome).toBe('AUTO_MATCHED');
    expect(r.status).toBe('MATCHED');

    const doc = await prisma.document.findUnique({
      where: { id: r.documentId },
      include: { matches: true },
    });
    expect(doc).not.toBeNull();
    expect(doc!.status).toBe('MATCHED');
    expect(doc!.matches).toHaveLength(1);
    expect(doc!.matches[0].status).toBe('AUTO_CONFIRMED');
    expect(doc!.matches[0].decidedBy).toBe('system');
    expect(doc!.contentHash).toBe(sha256(bytes));
  });

  test('whatsapp ambiguous receipt → NEEDS_REVIEW with multiple candidates', async () => {
    const bytes = await loadFixture('alfanar-fuel-ambiguous.txt');
    const r = await ingestDocument(
      {
        source: 'WHATSAPP',
        externalId: 'wamid_1',
        senderIdentifier: alRashed.driverPhone,
        fileBytes: bytes,
        mimeType: 'image/jpeg',
      },
      { extractor },
    );

    expect(r.outcome).toBe('NEEDS_REVIEW');
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.candidateCount).toBeGreaterThanOrEqual(2);

    const matches = await prisma.documentMatch.findMany({ where: { documentId: r.documentId } });
    expect(matches.every((m) => m.status === 'CANDIDATE')).toBe(true);
  });
});

describe('ingestion — idempotency', () => {
  test('same externalId → dedupe hit, no second document row', async () => {
    const bytes = await loadFixture('alrajhi-auto-tax-invoice.txt');
    const first = await ingestDocument(
      { source: 'EMAIL', externalId: 'msg_dup', senderIdentifier: alRashed.email, fileBytes: bytes, mimeType: 'application/pdf' },
      { extractor },
    );
    const second = await ingestDocument(
      { source: 'EMAIL', externalId: 'msg_dup', senderIdentifier: alRashed.email, fileBytes: bytes, mimeType: 'application/pdf' },
      { extractor },
    );
    expect(second.outcome).toBe('DUPLICATE');
    expect(second.documentId).toBe(first.documentId);
    const count = await prisma.document.count();
    expect(count).toBe(1);
  });

  test('different externalId but same content hash → still dedupes', async () => {
    const bytes = await loadFixture('alrajhi-auto-tax-invoice.txt');
    const first = await ingestDocument(
      { source: 'EMAIL', externalId: 'msg_a', senderIdentifier: alRashed.email, fileBytes: bytes, mimeType: 'application/pdf' },
      { extractor },
    );
    const second = await ingestDocument(
      { source: 'WHATSAPP', externalId: 'wamid_reupload', senderIdentifier: alRashed.driverPhone, fileBytes: bytes, mimeType: 'image/jpeg' },
      { extractor },
    );
    expect(second.outcome).toBe('DUPLICATE');
    expect(second.documentId).toBe(first.documentId);
  });

  test('the same bytes from another tenant are not treated as a duplicate', async () => {
    const bytes = await loadFixture('alrajhi-auto-tax-invoice.txt');
    const first = await ingestDocument(
      { source: 'EMAIL', externalId: 'msg_tenant_a', senderIdentifier: alRashed.email, fileBytes: bytes, mimeType: 'application/pdf' },
      { extractor },
    );
    const second = await ingestDocument(
      { source: 'EMAIL', externalId: 'msg_tenant_b', senderIdentifier: najm.email, fileBytes: bytes, mimeType: 'application/pdf' },
      { extractor },
    );
    expect(second.outcome).not.toBe('DUPLICATE');
    expect(second.documentId).not.toBe(first.documentId);
  });

  test('different scans with the same strong invoice identity dedupe within a tenant', async () => {
    const semanticExtractor: DocumentExtractor = {
      async extract() {
        return {
          documentType: 'TAX_INVOICE' as const, merchantName: 'Supplier', vatNumber: '310123456700003',
          totalAmount: 12000, currency: 'SAR', documentDate: '2025-06-20T10:05:00Z',
          cardLast4: '4411', invoiceNumber: 'INV-42', rawText: '', extractionConfidence: 0.99,
        };
      },
    };
    const first = await ingestDocument(
      { source: 'EMAIL', externalId: 'scan_a', senderIdentifier: alRashed.email, fileBytes: Buffer.from('full scan'), mimeType: 'image/jpeg' },
      { extractor: semanticExtractor },
    );
    const second = await ingestDocument(
      { source: 'EMAIL', externalId: 'scan_b', senderIdentifier: alRashed.email, fileBytes: Buffer.from('cropped scan'), mimeType: 'image/jpeg' },
      { extractor: semanticExtractor },
    );
    expect(second.outcome).toBe('DUPLICATE');
    expect(second.documentId).toBe(first.documentId);
  });
});

describe('ingestion policy helpers', () => {
  test('candidate date blocking uses a symmetric 30-day window', () => {
    const window = candidateDateWindow('2025-06-15T00:00:00Z')!;
    expect((window.lte.getTime() - window.gte.getTime()) / 86_400_000).toBe(60);
    expect(candidateDateWindow('invalid')).toBeNull();
  });

  test('auto-match audit sampling is deterministic and obeys boundary rates', () => {
    expect(shouldAuditAutoMatch('doc-1', 0)).toBe(false);
    expect(shouldAuditAutoMatch('doc-1', 1)).toBe(true);
    expect(shouldAuditAutoMatch('doc-1', 0.2)).toBe(shouldAuditAutoMatch('doc-1', 0.2));
  });
});

describe('ingestion — failure isolation', () => {
  test('extractor throws → document lands in FAILED, does not propagate', async () => {
    const throwingExtractor: DocumentExtractor = {
      async extract() { throw new Error('OCR provider down'); },
    };
    const r = await ingestDocument(
      { source: 'EMAIL', externalId: 'msg_fail', senderIdentifier: alRashed.email, fileBytes: Buffer.from('anything'), mimeType: 'application/pdf' },
      { extractor: throwingExtractor },
    );
    expect(r.outcome).toBe('FAILED');
    expect(r.status).toBe('FAILED');
    const doc = await prisma.document.findUnique({ where: { id: r.documentId } });
    expect(doc!.status).toBe('FAILED');
    expect(doc!.errorMessage).toContain('OCR provider down');
  });

  test('extractor timeout is isolated as FAILED', async () => {
    const stalledExtractor: DocumentExtractor = { extract: () => new Promise(() => undefined) };
    const result = await ingestDocument(
      { source: 'EMAIL', externalId: 'msg_timeout', senderIdentifier: alRashed.email, fileBytes: Buffer.from('slow'), mimeType: 'image/jpeg' },
      { extractor: stalledExtractor, extractionTimeoutMs: 5 },
    );
    expect(result.outcome).toBe('FAILED');
    expect(result.errorMessage).toContain('timed out');
  });

  test('extractor returns UNKNOWN with null amount → FAILED status', async () => {
    const garbageExtractor: DocumentExtractor = {
      async extract(): Promise<ExtractedDocument> {
        return {
          documentType: 'UNKNOWN',
          merchantName: null, vatNumber: null, totalAmount: null,
          currency: null, documentDate: null, cardLast4: null, invoiceNumber: null,
          rawText: '', extractionConfidence: 0.02,
        };
      },
    };
    const r = await ingestDocument(
      { source: 'WHATSAPP', externalId: 'wamid_garbage', senderIdentifier: alRashed.driverPhone, fileBytes: Buffer.from('blurry'), mimeType: 'image/jpeg' },
      { extractor: garbageExtractor },
    );
    expect(r.outcome).toBe('FAILED');
    const doc = await prisma.document.findUnique({ where: { id: r.documentId } });
    expect(doc!.status).toBe('FAILED');
    expect(doc!.rawText).toBe('');
  });

  test('invalid extracted date is contained and leaves a FAILED document', async () => {
    const invalidDateExtractor: DocumentExtractor = {
      async extract(): Promise<ExtractedDocument> {
        return {
          documentType: 'RECEIPT',
          merchantName: 'Alfanar Fuel Station',
          vatNumber: null,
          totalAmount: 25000,
          currency: 'SAR',
          documentDate: 'not-a-date',
          cardLast4: '4411',
          invoiceNumber: null,
          rawText: 'readable but malformed date',
          extractionConfidence: 0.9,
        };
      },
    };

    const result = await ingestDocument(
      {
        source: 'EMAIL',
        externalId: 'msg_invalid_date',
        senderIdentifier: alRashed.email,
        fileBytes: Buffer.from('invalid-date-fixture'),
        mimeType: 'application/pdf',
      },
      { extractor: invalidDateExtractor },
    );

    expect(result.outcome).toBe('FAILED');
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: result.documentId } });
    expect(stored.status).toBe('FAILED');
    expect(stored.errorMessage).toContain('pipeline:');
  });
});

describe('ingestion — sender scoping', () => {
  test('email sender not in ClientEmail allowlist → UNMATCHED (no candidates)', async () => {
    const bytes = await loadFixture('alrajhi-auto-tax-invoice.txt');
    const r = await ingestDocument(
      { source: 'EMAIL', externalId: 'msg_stranger', senderIdentifier: 'stranger@somewhere.example', fileBytes: bytes, mimeType: 'application/pdf' },
      { extractor },
    );
    expect(r.outcome).toBe('UNMATCHED');
    expect(r.candidateCount).toBe(0);
  });

  test('whatsapp sender does not match any driverPhone → UNMATCHED', async () => {
    const bytes = await loadFixture('petromin-najm-exact.txt');
    const r = await ingestDocument(
      { source: 'WHATSAPP', externalId: 'wamid_nobody', senderIdentifier: '+966599999999', fileBytes: bytes, mimeType: 'image/jpeg' },
      { extractor },
    );
    expect(r.outcome).toBe('UNMATCHED');
  });

  test('whatsapp Najm driver only sees Najm transactions', async () => {
    // Use the Alfanar-ambiguous receipt (SAR 250) — Al Rashed has matching txs,
    // Najm does not. Ensure Najm's scope doesn't leak into Al Rashed.
    const bytes = await loadFixture('alfanar-fuel-ambiguous.txt');
    const r = await ingestDocument(
      { source: 'WHATSAPP', externalId: 'wamid_najm_alfanar', senderIdentifier: najm.driverPhone, fileBytes: bytes, mimeType: 'image/jpeg' },
      { extractor },
    );
    // Najm has an Alfanar Fuel tx (SAR 200, 2025-06-19) — but amount differs.
    // Expect UNMATCHED because no candidate scores above the review floor.
    expect(['UNMATCHED', 'NEEDS_REVIEW']).toContain(r.outcome);
    const matches = await prisma.documentMatch.findMany({ where: { documentId: r.documentId } });
    // Any persisted matches must belong to Najm — never to Al Rashed.
    for (const m of matches) {
      const t = await prisma.transaction.findUnique({ where: { id: m.transactionId } });
      expect(t!.clientId).toBe(najm.clientId);
    }
  });
});
