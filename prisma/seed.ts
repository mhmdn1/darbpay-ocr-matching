/**
 * Seed data for the Darb take-home.
 *
 * Two clients with driver/email mappings, 15 card transactions, arranged
 * to exercise the matcher's edge cases when paired with the fixture
 * extractions in lib/extraction/mock-extractor.ts.
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

import { PrismaClient } from '../lib/generated/prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? 'file:./dev.db',
});
const prisma = new PrismaClient({ adapter });

async function main() {
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

  await prisma.transaction.createMany({
    data: [
      ...alRashedTx.map((tx) => ({ ...tx, clientId: alRashed.id, currency: 'SAR' })),
      ...najmTx.map((tx) => ({ ...tx, clientId: najm.id, currency: 'SAR' })),
    ],
  });

  const clients = await prisma.client.count();
  const transactions = await prisma.transaction.count();
  console.log(`seeded: ${clients} clients, ${transactions} transactions`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
