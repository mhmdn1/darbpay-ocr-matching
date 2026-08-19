import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import prisma from '@/lib/prisma';
import { ingestDocument } from '@/lib/services/document-ingestion';
import { MockExtractor } from '@/lib/extraction/mock-extractor';
import { rematchUnmatched } from '@/lib/services/rematch-unmatched';
import type { DocumentExtractor } from '@/lib/extraction/types';

let extractor: DocumentExtractor;

beforeAll(async () => {
  extractor = await MockExtractor.create();
});

beforeEach(async () => {
  await prisma.documentMatch.deleteMany();
  await prisma.document.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.clientEmail.deleteMany();
  await prisma.client.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

test('document arriving BEFORE its transaction — rematchUnmatched promotes it to MATCHED', async () => {
  // Seed only the client + email — no transactions yet.
  const alRashed = await prisma.client.create({
    data: {
      name: 'Al Rashed Logistics',
      emails: { create: [{ email: 'fleet@alrashed.example' }] },
    },
  });

  // Deliver the Alrajhi invoice with no matching transaction in the system.
  const bytes = await readFile(join(process.cwd(), 'fixtures/documents/alrajhi-auto-tax-invoice.txt'));
  const first = await ingestDocument(
    {
      source: 'EMAIL',
      externalId: 'msg_early_bird',
      senderIdentifier: 'fleet@alrashed.example',
      fileBytes: bytes,
      mimeType: 'application/pdf',
    },
    { extractor },
  );
  expect(first.outcome).toBe('UNMATCHED');

  // Now the matching transaction lands.
  await prisma.transaction.create({
    data: {
      clientId: alRashed.id,
      cardLast4: '4411',
      driverPhone: '+966501111111',
      merchantName: 'ALRAJHI AUTO SVC RUH',
      amount: 120000,
      currency: 'SAR',
      transactionAt: new Date('2025-06-20T10:05:00Z'),
    },
  });

  const rematched = await rematchUnmatched({ clientId: alRashed.id });
  expect(rematched).toHaveLength(1);
  expect(rematched[0].documentId).toBe(first.documentId);
  expect(rematched[0].outcome).toBe('AUTO_MATCHED');

  const doc = await prisma.document.findUnique({
    where: { id: first.documentId },
    include: { matches: true },
  });
  expect(doc!.status).toBe('MATCHED');
  expect(doc!.matches).toHaveLength(1);
  expect(doc!.matches[0].status).toBe('AUTO_CONFIRMED');
  expect(doc!.matches[0].decidedBy).toBe('system-rematch');
});

test('rematchUnmatched with no scope returns no work', async () => {
  const results = await rematchUnmatched({});
  expect(results).toEqual([]);
});
