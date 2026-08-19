import {
  matchDocument,
  MATCHER_CONFIG,
  type CandidateTransaction,
  type ExtractedFields,
} from '@/lib/services/transaction-matcher';

function tx(overrides: Partial<CandidateTransaction> = {}): CandidateTransaction {
  return {
    id: 1,
    cardLast4: '4411',
    merchantName: 'ALFANAR FUEL ST 04 RUH',
    amount: 25000,
    currency: 'SAR',
    transactionAt: new Date('2025-06-14T08:15:00Z'),
    hasConfirmedDocument: false,
    ...overrides,
  };
}

function doc(overrides: Partial<ExtractedFields> = {}): ExtractedFields {
  return {
    documentType: 'RECEIPT',
    merchantName: 'Alfanar Fuel Station',
    totalAmount: 25000,
    currency: 'SAR',
    documentDate: '2025-06-14T08:15:00Z',
    cardLast4: '4411',
    ...overrides,
  };
}

describe('matchDocument — edge cases', () => {
  test('#1 exact match → AUTO_MATCHED with a large gap over the runner-up', () => {
    const result = matchDocument(doc(), [
      tx({ id: 1 }),
      tx({ id: 2, merchantName: 'PANDA SUPERMARKET', amount: 42000, transactionAt: new Date('2025-06-18T18:14:00Z') }),
    ]);
    expect(result.outcome).toBe('AUTO_MATCHED');
    expect(result.candidates[0].transactionId).toBe(1);
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(MATCHER_CONFIG.thresholds.autoMatch);
    expect(result.candidates[0].confidence - result.candidates[1].confidence)
      .toBeGreaterThanOrEqual(MATCHER_CONFIG.thresholds.autoMatchGap);
    expect(result.candidates[0].signals).toEqual(expect.objectContaining({
      amount: 1, date: 1, merchant: 1, cardLast4: 1,
    }));
  });

  test('#2 two same-amount / same-day / same-merchant transactions → NEEDS_REVIEW', () => {
    const result = matchDocument(
      doc({ cardLast4: null }),
      [
        tx({ id: 1, transactionAt: new Date('2025-06-14T08:15:00Z') }),
        tx({ id: 2, transactionAt: new Date('2025-06-14T09:32:00Z') }),
      ],
    );
    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    // Near-tie
    const gap = result.candidates[0].confidence - result.candidates[1].confidence;
    expect(gap).toBeLessThan(MATCHER_CONFIG.thresholds.autoMatchGap);
  });

  test('#3 amount off by a tip → still matches (via tolerance band)', () => {
    // Receipt SAR 57.50, tx SAR 63.25 — receipt is smaller by ~9%.
    const result = matchDocument(
      doc({
        merchantName: 'Marhaba Restaurant',
        totalAmount: 5750,
        documentDate: '2025-06-17T12:30:00Z',
      }),
      [tx({ id: 5, merchantName: 'MARHABA REST AL MALAZ RUH', amount: 6325, transactionAt: new Date('2025-06-17T12:33:00Z') })],
    );
    // Might be AUTO_MATCHED or NEEDS_REVIEW depending on merchant fuzz —
    // what matters is: it produces a candidate at above the review floor.
    expect(result.outcome).not.toBe('UNMATCHED');
    expect(result.candidates[0].transactionId).toBe(5);
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(MATCHER_CONFIG.thresholds.review);
    expect(result.candidates[0].signals.amount).toBeGreaterThan(0.5); // tip band kicked in
  });

  test('#5 orphan invoice (no plausible match) → UNMATCHED', () => {
    const result = matchDocument(
      doc({
        documentType: 'TAX_INVOICE',
        merchantName: 'Zamil Steel Industries',
        totalAmount: 100000,
        cardLast4: null,
      }),
      [tx({ id: 1, merchantName: 'ALFANAR FUEL ST 04 RUH', amount: 25000 })],
    );
    expect(result.outcome).toBe('UNMATCHED');
    expect(result.candidates).toHaveLength(0);
  });

  test('#6 garbage extraction (UNKNOWN, all fields null) → UNMATCHED, no crash', () => {
    const result = matchDocument(
      { documentType: 'UNKNOWN', merchantName: null, totalAmount: null, currency: null, documentDate: null, cardLast4: null },
      [tx()],
    );
    expect(result.outcome).toBe('UNMATCHED');
    expect(result.candidates).toHaveLength(0);
  });

  test('empty candidate list → UNMATCHED', () => {
    expect(matchDocument(doc(), []).outcome).toBe('UNMATCHED');
  });
});

describe('matchDocument — cardLast4 mismatch', () => {
  test('receipt card differs from transaction card → confidence penalized (no auto-match)', () => {
    const result = matchDocument(
      doc({ cardLast4: '9999' }),
      [tx({ id: 1, cardLast4: '4411' })],
    );
    // Penalized enough that we do NOT auto-match despite otherwise-perfect fields.
    expect(result.outcome).not.toBe('AUTO_MATCHED');
    if (result.candidates.length > 0) {
      expect(result.candidates[0].signals.cardLast4).toBe(0);
      expect(result.candidates[0].confidence).toBeLessThan(MATCHER_CONFIG.thresholds.autoMatch);
    }
  });
});

describe('matchDocument — one-confirmed-per-transaction rule', () => {
  test('top candidate already has a confirmed document → routed to NEEDS_REVIEW (duplicate suspected)', () => {
    const result = matchDocument(doc(), [tx({ id: 1, hasConfirmedDocument: true })]);
    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.candidates[0].transactionId).toBe(1);
  });
});

describe('matchDocument — currency mismatch', () => {
  test('doc currency differs from tx currency → amount signal drops to 0', () => {
    const result = matchDocument(doc({ currency: 'USD' }), [tx({ currency: 'SAR' })]);
    // Not enough remaining signal strength to auto-match.
    expect(result.outcome).not.toBe('AUTO_MATCHED');
    if (result.candidates[0]) expect(result.candidates[0].signals.amount).toBe(0);
  });
});

describe('matchDocument — partial extraction', () => {
  test('only merchant + amount + date present → confidence still normalizes across available signals', () => {
    const result = matchDocument(doc({ cardLast4: null }), [tx()]);
    expect(result.outcome).toBe('AUTO_MATCHED');
    // Signals object should not contain cardLast4 when the doc didn't have one.
    expect('cardLast4' in result.candidates[0].signals).toBe(false);
  });
});

describe('matchDocument — trimming', () => {
  test('never returns more than MATCHER_CONFIG.maxCandidates', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => tx({ id: i + 1 }));
    const result = matchDocument(doc(), candidates);
    expect(result.candidates.length).toBeLessThanOrEqual(MATCHER_CONFIG.maxCandidates);
  });
});
