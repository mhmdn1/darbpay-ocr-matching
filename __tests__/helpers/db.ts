import prisma from '@/lib/prisma';

/** Wipe all rows. Call in beforeEach for a clean slate. */
export async function resetDatabase(): Promise<void> {
  await prisma.documentMatch.deleteMany();
  await prisma.document.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.clientEmail.deleteMany();
  await prisma.client.deleteMany();
}

export interface SeededClient {
  clientId: number;
  email: string;
  driverPhone: string;
}

/**
 * Seed a minimal 2-client / 15-transaction dataset that mirrors the shape
 * of prisma/seed.ts but returns the resolved IDs so tests can assert
 * directly.
 */
export async function seedBaseData(): Promise<{ alRashed: SeededClient; najm: SeededClient }> {
  const alRashed = await prisma.client.create({
    data: {
      name: 'Al Rashed Logistics',
      emails: { create: [{ email: 'fleet@alrashed.example' }] },
    },
  });
  const najm = await prisma.client.create({
    data: {
      name: 'Najm Transport',
      emails: { create: [{ email: 'ops@najm.example' }] },
    },
  });

  await prisma.transaction.createMany({
    data: [
      // Al Rashed — ambiguous pair for Alfanar Fuel + Alrajhi + Marhaba + noise
      { clientId: alRashed.id, cardLast4: '4411', driverPhone: '+966501111111', merchantName: 'ALFANAR FUEL ST 04 RUH', amount: 25000, currency: 'SAR', transactionAt: new Date('2025-06-14T08:15:00Z') },
      { clientId: alRashed.id, cardLast4: '4411', driverPhone: '+966501111111', merchantName: 'ALFANAR FUEL ST 04 RUH', amount: 25000, currency: 'SAR', transactionAt: new Date('2025-06-14T09:32:00Z') },
      { clientId: alRashed.id, cardLast4: '4411', driverPhone: '+966501111111', merchantName: 'MARHABA REST AL MALAZ RUH', amount: 6325, currency: 'SAR', transactionAt: new Date('2025-06-17T12:33:00Z') },
      { clientId: alRashed.id, cardLast4: '4411', driverPhone: '+966501111111', merchantName: 'ALRAJHI AUTO SVC RUH', amount: 120000, currency: 'SAR', transactionAt: new Date('2025-06-20T10:05:00Z') },
      { clientId: alRashed.id, cardLast4: '4411', driverPhone: '+966501111111', merchantName: 'PANDA SUPERMARKET', amount: 42000, currency: 'SAR', transactionAt: new Date('2025-06-18T18:14:00Z') },
      { clientId: alRashed.id, cardLast4: '4411', driverPhone: '+966501111111', merchantName: 'STC PAYMENT', amount: 50000, currency: 'SAR', transactionAt: new Date('2025-06-16T15:00:00Z') },
      { clientId: alRashed.id, cardLast4: '4411', driverPhone: '+966501111111', merchantName: 'ALFANAR FUEL ST 12 JED', amount: 18000, currency: 'SAR', transactionAt: new Date('2025-06-15T09:00:00Z') },
      // Najm
      { clientId: najm.id, cardLast4: '8823', driverPhone: '+966502222222', merchantName: 'PETROMIN EXPRESS JED HAMRA', amount: 30000, currency: 'SAR', transactionAt: new Date('2025-06-14T08:03:00Z') },
      { clientId: najm.id, cardLast4: '8823', driverPhone: '+966502222222', merchantName: 'AL BAIK REST JED', amount: 8500, currency: 'SAR', transactionAt: new Date('2025-06-15T13:00:00Z') },
      { clientId: najm.id, cardLast4: '8823', driverPhone: '+966502222222', merchantName: 'EXTRA ELECTRONICS', amount: 250000, currency: 'SAR', transactionAt: new Date('2025-06-17T14:00:00Z') },
      { clientId: najm.id, cardLast4: '8823', driverPhone: '+966502222222', merchantName: 'CAREEM RIDE', amount: 4200, currency: 'SAR', transactionAt: new Date('2025-06-19T22:00:00Z') },
      { clientId: najm.id, cardLast4: '8823', driverPhone: '+966502222222', merchantName: 'NESMA TOLL', amount: 2500, currency: 'SAR', transactionAt: new Date('2025-06-18T09:00:00Z') },
      { clientId: najm.id, cardLast4: '8823', driverPhone: '+966502222222', merchantName: 'AL BAIK REST JED', amount: 4500, currency: 'SAR', transactionAt: new Date('2025-06-20T13:00:00Z') },
      { clientId: najm.id, cardLast4: '8823', driverPhone: '+966502222222', merchantName: 'PETROMIN EXPRESS JED', amount: 14550, currency: 'SAR', transactionAt: new Date('2025-06-16T11:00:00Z') },
      { clientId: najm.id, cardLast4: '8823', driverPhone: '+966502222222', merchantName: 'ALFANAR FUEL ST 22 JED', amount: 20000, currency: 'SAR', transactionAt: new Date('2025-06-19T07:00:00Z') },
    ],
  });

  return {
    alRashed: { clientId: alRashed.id, email: 'fleet@alrashed.example', driverPhone: '+966501111111' },
    najm: { clientId: najm.id, email: 'ops@najm.example', driverPhone: '+966502222222' },
  };
}
