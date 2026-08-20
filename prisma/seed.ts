/**
 * Seed data for the Darb take-home.
 *
 * Two clients with driver/email mappings, 17 card transactions, and a curated
 * review-page demo. Every document is sent through the real ingestion pipeline
 * using fixture-backed extraction; no DocumentMatch rows are hand-authored.
 * Pass --transactions-only to load client/transaction reference data without
 * documents. That mode is used before exercising the sample webhooks.
 *
 *   client 1 (Al Rashed Logistics)
 *     driver +966501111111 | inbound email fleet@alrashed.example
 *     card 4411
 *   client 2 (Najm Transport)
 *     driver +966502222222 | inbound email ops@najm.example, receipts@najm.example
 *     card 8823
 *
 * Fixture ↔ transaction map:
 *   alrajhi-auto-tax-invoice.txt   → tx #4  (exact match)
 *   alfanar-fuel-ambiguous.txt     → tx #1 and #2 (ambiguous — same amt/day)
 *   marhaba-restaurant-tip.txt     → tx #3 (tip case)
 *   zamil-steel-orphan.txt         → (orphan — no match)
 *   garbage-blurry.txt             → (extraction fails)
 *   petromin-najm-exact.txt        → tx #8 (exact match, client 2)
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '../lib/generated/prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { MockExtractor } from '../lib/extraction/mock-extractor';
import { ingestDocument, type IngestionSource } from '../lib/services/document-ingestion';

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? 'file:./dev.db',
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const transactionsOnly = process.argv.includes('--transactions-only');

  // Wipe in FK-safe order (dev-only seed).
  await prisma.documentMatch.deleteMany();
  await prisma.document.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.clientEmail.deleteMany();
  await prisma.client.deleteMany();

  const alRashed = await prisma.client.create({
    data: {
      name: 'Al Rashed Logistics',
      emails: { create: [{ email: 'fleet@alrashed.example' }] },
    },
  });

  const najm = await prisma.client.create({
    data: {
      name: 'Najm Transport',
      emails: {
        create: [
          { email: 'ops@najm.example' },
          { email: 'receipts@najm.example' },
        ],
      },
    },
  });

  const alRashedTx = [
    // #1, #2 — ambiguous pair (same merchant, day, amount, card)
    {
      merchantName: 'ALFANAR FUEL ST 04 RUH',
      amount: 25000,
      transactionAt: new Date('2025-06-14T08:15:00Z'),
      cardLast4: '4411',
      driverPhone: '+966501111111',
    },
    {
      merchantName: 'ALFANAR FUEL ST 04 RUH',
      amount: 25000,
      transactionAt: new Date('2025-06-14T09:32:00Z'),
      cardLast4: '4411',
      driverPhone: '+966501111111',
    },
    // #3 — tip case (charged more than the receipt subtotal)
    {
      merchantName: 'MARHABA REST AL MALAZ RUH',
      amount: 6325,
      transactionAt: new Date('2025-06-17T12:33:00Z'),
      cardLast4: '4411',
      driverPhone: '+966501111111',
    },
    // #4 — exact match target for the Alrajhi invoice
    {
      merchantName: 'ALRAJHI AUTO SVC RUH',
      amount: 120000,
      transactionAt: new Date('2025-06-20T10:05:00Z'),
      cardLast4: '4411',
      driverPhone: '+966501111111',
    },
    // #5..#7 — noise
    {
      merchantName: 'PANDA SUPERMARKET',
      amount: 42000,
      transactionAt: new Date('2025-06-18T18:14:00Z'),
      cardLast4: '4411',
      driverPhone: '+966501111111',
    },
    {
      merchantName: 'STC PAYMENT',
      amount: 50000,
      transactionAt: new Date('2025-06-16T15:00:00Z'),
      cardLast4: '4411',
      driverPhone: '+966501111111',
    },
    {
      merchantName: 'ALFANAR FUEL ST 12 JED',
      amount: 18000,
      transactionAt: new Date('2025-06-15T09:00:00Z'),
      cardLast4: '4411',
      driverPhone: '+966501111111',
    },
  ] as const;

  const najmTx = [
    // #8 — exact match target for the Petromin receipt
    {
      merchantName: 'PETROMIN EXPRESS JED HAMRA',
      amount: 30000,
      transactionAt: new Date('2025-06-14T08:03:00Z'),
      cardLast4: '8823',
      driverPhone: '+966502222222',
    },
    // #9..#15 — noise
    {
      merchantName: 'AL BAIK REST JED',
      amount: 8500,
      transactionAt: new Date('2025-06-15T13:00:00Z'),
      cardLast4: '8823',
      driverPhone: '+966502222222',
    },
    {
      merchantName: 'EXTRA ELECTRONICS',
      amount: 250000,
      transactionAt: new Date('2025-06-17T14:00:00Z'),
      cardLast4: '8823',
      driverPhone: '+966502222222',
    },
    {
      merchantName: 'CAREEM RIDE',
      amount: 4200,
      transactionAt: new Date('2025-06-19T22:00:00Z'),
      cardLast4: '8823',
      driverPhone: '+966502222222',
    },
    {
      merchantName: 'NESMA TOLL',
      amount: 2500,
      transactionAt: new Date('2025-06-18T09:00:00Z'),
      cardLast4: '8823',
      driverPhone: '+966502222222',
    },
    {
      merchantName: 'AL BAIK REST JED',
      amount: 4500,
      transactionAt: new Date('2025-06-20T13:00:00Z'),
      cardLast4: '8823',
      driverPhone: '+966502222222',
    },
    {
      merchantName: 'PETROMIN EXPRESS JED',
      amount: 14550,
      transactionAt: new Date('2025-06-16T11:00:00Z'),
      cardLast4: '8823',
      driverPhone: '+966502222222',
    },
    {
      merchantName: 'ALFANAR FUEL ST 22 JED',
      amount: 20000,
      transactionAt: new Date('2025-06-19T07:00:00Z'),
      cardLast4: '8823',
      driverPhone: '+966502222222',
    },
  ] as const;

  const demoTx = [
    // Close branch decision: receipt evidence prefers branch 04 Riyadh, but
    // branch 12 Jeddah remains plausible enough to require human review.
    {
      merchantName: 'NOUR CAFE BR 04 RUH',
      merchantCategory: 'CAFE',
      merchantCity: 'RIYADH',
      amount: 8750,
      transactionAt: new Date('2025-06-22T08:15:00Z'),
      cardLast4: '4411',
      driverPhone: '+966501111111',
    },
    {
      merchantName: 'NOUR CAFE BR 12 JED',
      merchantCategory: 'CAFE',
      merchantCity: 'JEDDAH',
      amount: 8750,
      transactionAt: new Date('2025-06-22T08:45:00Z'),
      cardLast4: '4411',
      driverPhone: '+966501111111',
    },
  ] as const;

  await prisma.transaction.createMany({
    data: [
      ...alRashedTx.map((tx, index) => ({
        ...tx,
        clientId: alRashed.id,
        currency: 'SAR',
        ...(index === 3 ? { merchantVatNumber: '300123456700003' } : {}),
      })),
      ...najmTx.map((tx) => ({ ...tx, clientId: najm.id, currency: 'SAR' })),
      ...demoTx.map((tx) => ({ ...tx, clientId: alRashed.id, currency: 'SAR' })),
    ],
  });

  if (transactionsOnly) {
    const clients = await prisma.client.count();
    const transactions = await prisma.transaction.count();
    console.log(`seeded webhook prerequisites: ${clients} clients, ${transactions} transactions, 0 documents`);
    return;
  }

  const demoDocuments: Array<{
    file: string;
    source: IngestionSource;
    senderIdentifier: string;
    externalId: string;
    mimeType: string;
    receivedAt: Date;
  }> = [
    // First confirm the original Alrajhi invoice; the following customer copy
    // then demonstrates the one-confirmed-document-per-transaction safeguard.
    { file: 'alrajhi-auto-tax-invoice.txt', source: 'EMAIL', senderIdentifier: 'fleet@alrashed.example', externalId: 'demo-email-alrajhi', mimeType: 'application/pdf', receivedAt: new Date('2025-06-20T10:06:00Z') },
    { file: 'alrajhi-duplicate-receipt.txt', source: 'EMAIL', senderIdentifier: 'fleet@alrashed.example', externalId: 'demo-email-alrajhi-copy', mimeType: 'application/pdf', receivedAt: new Date('2025-06-20T10:09:00Z') },
    { file: 'alfanar-fuel-ambiguous.txt', source: 'WHATSAPP', senderIdentifier: '+966501111111', externalId: 'demo-wa-alfanar-tie', mimeType: 'image/jpeg', receivedAt: new Date('2025-06-14T08:24:00Z') },
    { file: 'stc-missing-date.txt', source: 'WHATSAPP', senderIdentifier: '+966501111111', externalId: 'demo-wa-stc-missing-date', mimeType: 'image/jpeg', receivedAt: new Date('2025-06-16T15:02:00Z') },
    { file: 'nour-cafe-branch-choice.txt', source: 'WHATSAPP', senderIdentifier: '+966501111111', externalId: 'demo-wa-nour-branch', mimeType: 'image/jpeg', receivedAt: new Date('2025-06-22T08:22:00Z') },
    { file: 'marhaba-restaurant-tip.txt', source: 'WHATSAPP', senderIdentifier: '+966501111111', externalId: 'demo-wa-marhaba-tip', mimeType: 'image/jpeg', receivedAt: new Date('2025-06-17T12:35:00Z') },
    { file: 'petromin-najm-exact.txt', source: 'WHATSAPP', senderIdentifier: '+966502222222', externalId: 'demo-wa-petromin', mimeType: 'image/jpeg', receivedAt: new Date('2025-06-14T08:05:00Z') },
    { file: 'zamil-steel-orphan.txt', source: 'EMAIL', senderIdentifier: 'fleet@alrashed.example', externalId: 'demo-email-zamil-orphan', mimeType: 'application/pdf', receivedAt: new Date('2025-06-14T09:00:00Z') },
    { file: 'panda-currency-conflict.txt', source: 'WHATSAPP', senderIdentifier: '+966501111111', externalId: 'demo-wa-panda-currency', mimeType: 'image/jpeg', receivedAt: new Date('2025-06-18T18:16:00Z') },
    { file: 'garbage-blurry.txt', source: 'WHATSAPP', senderIdentifier: '+966501111111', externalId: 'demo-wa-garbage', mimeType: 'image/jpeg', receivedAt: new Date('2025-06-21T07:00:00Z') },
  ];

  const extractor = await MockExtractor.create();
  const outcomes = new Map<string, number>();
  for (const demo of demoDocuments) {
    const fileBytes = await readFile(join(process.cwd(), 'fixtures', 'documents', demo.file));
    const result = await ingestDocument(
      {
        source: demo.source,
        externalId: demo.externalId,
        senderIdentifier: demo.senderIdentifier,
        fileBytes,
        mimeType: demo.mimeType,
        receivedAt: demo.receivedAt,
      },
      { prisma, extractor, autoMatchAuditRate: 0 },
    );
    outcomes.set(result.outcome, (outcomes.get(result.outcome) ?? 0) + 1);
  }

  const clients = await prisma.client.count();
  const transactions = await prisma.transaction.count();
  const documents = await prisma.document.count();
  console.log(`seeded demo: ${clients} clients, ${transactions} transactions, ${documents} documents`);
  console.log(`outcomes: ${[...outcomes].map(([outcome, count]) => `${outcome}=${count}`).join(', ')}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
