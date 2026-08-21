import {
  matchDocument,
  parseMerchantDescriptor,
  scoreAmount,
  scoreDate,
  scoreMerchant,
  scoreTransaction,
  type CandidateTransaction,
  type ExtractedFields,
} from '@/lib/services/transaction-matcher';

function transaction(overrides: Partial<CandidateTransaction> = {}): CandidateTransaction {
  return {
    id: 1,
    cardLast4: '4411',
    merchantName: 'ALFANAR FUEL ST 04 RUH',
    amount: 25_000,
    currency: 'SAR',
    transactionAt: new Date('2025-06-14T08:15:00Z'),
    hasConfirmedDocument: false,
    ...overrides,
  };
}

function document(overrides: Partial<ExtractedFields> = {}): ExtractedFields {
  return {
    documentType: 'RECEIPT',
    merchantName: 'Alfanar Fuel Station',
    totalAmount: 25_000,
    currency: 'SAR',
    documentDate: '2025-06-14T08:15:00Z',
    dateSource: 'DOCUMENT',
    cardLast4: '4411',
    ...overrides,
  };
}

/**
 * Approximately fifty deliberately small cases covering the matcher's decision boundaries.
 * Keep this matrix data-driven: adding a row documents a new business rule
 * without making the suite expensive or dependent on a database fixture.
 */

describe('50-case matcher edge matrix — amount boundaries (1–12)', () => {
  test.each([
    ['01 exact amounts', 25_000, 25_000, {}, 1],
    ['02 absolute tolerance at +100 halalas', 25_100, 25_000, {}, 1],
    ['03 absolute tolerance at -100 halalas', 24_900, 25_000, {}, 1],
    ['04 just outside absolute tolerance with tips disabled', 24_899, 25_000, { allowTip: false }, 0],
    ['05 relative tolerance dominates for a large amount', 998_000, 1_000_000, {}, 1],
    ['06 just outside relative tolerance with tips disabled', 997_999, 1_000_000, { allowTip: false }, 0],
    ['07 receipt overshoot at exactly 2%', 10_200, 10_000, {}, 0.9],
    ['08 receipt overshoot just above 2%', 10_201, 10_000, {}, 0],
    ['09 tip at exactly 30%', 7_000, 10_000, {}, 0.5],
    ['10 tip just above 30%', 6_999, 10_000, {}, 0],
    ['11 zero document amount', 0, 10_000, {}, 0],
    ['12 negative transaction amount', 10_000, -1, {}, 0],
  ] as const)('%s', (_name, docAmount, txAmount, options, expected) => {
    expect(scoreAmount(docAmount, txAmount, options)).toBe(expected);
  });
});

describe('50-case matcher edge matrix — date boundaries (13–22)', () => {
  const base = new Date('2025-06-14T08:00:00Z');

  test.each([
    ['13 same instant', base, 1],
    ['14 different time on the same Riyadh date', new Date('2025-06-14T18:00:00Z'), 1],
    ['15 next Riyadh date but less than 24 hours', new Date('2025-06-14T22:00:00Z'), 0.98],
    ['16 exactly one day', new Date('2025-06-15T08:00:00Z'), 0.98],
    ['17 exactly two days', new Date('2025-06-16T08:00:00Z'), 0.84],
    ['18 exactly three days', new Date('2025-06-17T08:00:00Z'), 0.7],
    ['19 exactly four days', new Date('2025-06-18T08:00:00Z'), 0.655],
    ['20 exactly fourteen days', new Date('2025-06-28T08:00:00Z'), 0.2],
    ['21 just beyond fourteen days', new Date('2025-06-28T08:00:00.001Z'), 0],
    ['22 invalid document date', new Date('invalid'), 0],
  ] as const)('%s', (_name, candidate, expected) => {
    expect(scoreDate(candidate, base)).toBeCloseTo(expected, 3);
  });
});

describe('50-case matcher edge matrix — merchant identity (23–32)', () => {
  test.each([
    ['23 case and punctuation are ignored', 'Al-Fanar, Fuel!', 'AL FANAR FUEL', 1],
    ['24 acquirer noise tokens are ignored', 'Alfanar Fuel Station Branch 04 Riyadh', 'ALFANAR FUEL RIYADH', 1],
    ['25 Arabic diacritics and tatweel are ignored', 'مَحَطَّة الـنُّور', 'النور', 1],
    ['26 Arabic and Latin digit-only branch tokens do not pollute the core', 'النور فرع ٠٤', 'النور فرع 04', 1],
    ['27 unrelated merchants remain weak', 'Panda Supermarket', 'STC Payment', 0.3],
    ['28 token reordering retains meaningful overlap', 'Fuel Alfanar', 'Alfanar Fuel', 0.5],
  ] as const)('%s', (_name, left, right, boundary) => {
    const score = scoreMerchant(left, right);
    if (_name.startsWith('27')) expect(score).toBeLessThan(boundary);
    else expect(score).toBeGreaterThanOrEqual(boundary);
  });

  test('29 parses a Riyadh acquirer branch descriptor', () => {
    expect(parseMerchantDescriptor('ALFANAR FUEL ST 04 RUH')).toEqual({
      core: 'ALFANAR FUEL', city: 'RIYADH', branch: '04',
    });
  });

  test('30 parses an Arabic Jeddah branch descriptor and normalizes its digits', () => {
    expect(parseMerchantDescriptor('محطة النور جدة فرع ٠٤')).toEqual({
      core: 'النور جدة', city: 'JEDDAH', branch: '04',
    });
  });

  test('31 records an exact branch as positive evidence', () => {
    const candidate = scoreTransaction(
      document({ merchantName: 'Alfanar Fuel Branch 04 Riyadh' }),
      transaction(),
    );
    expect(candidate.signals.merchantBranch).toBe(1);
    expect(candidate.signals.merchantCity).toBe(1);
  });

  test('32 records a different branch as negative context without a hard contradiction', () => {
    const candidate = scoreTransaction(
      document({ merchantName: 'Alfanar Fuel Branch 12 Riyadh' }),
      transaction(),
    );
    expect(candidate.signals.merchantBranch).toBe(0);
    expect(candidate.contradictions).toEqual([]);
  });
});

describe('50-case matcher edge matrix — extraction reliability and identifiers (33–42)', () => {
  test('33 zero-confidence evidence is visible but contributes no coverage', () => {
    const candidate = scoreTransaction(
      document({ merchantName: null, documentDate: null, cardLast4: null, fieldConfidences: { totalAmount: 0 } }),
      transaction(),
    );
    expect(candidate.availableSignals).toEqual(['amount']);
    expect(candidate.evidenceCoverage).toBe(0);
    expect(candidate.confidence).toBe(0);
  });

  test('34 extraction confidence above one is clamped', () => {
    const candidate = scoreTransaction(
      document({ merchantName: null, documentDate: null, cardLast4: null, fieldConfidences: { totalAmount: 9 } }),
      transaction(),
    );
    expect(candidate.evidenceCoverage).toBe(0.3);
    expect(candidate.confidence).toBe(1);
  });

  test('35 negative extraction confidence is clamped to zero', () => {
    const candidate = scoreTransaction(
      document({ merchantName: null, totalAmount: null, cardLast4: null, fieldConfidences: { documentDate: -1 } }),
      transaction(),
    );
    expect(candidate.availableSignals).toEqual(['date']);
    expect(candidate.evidenceCoverage).toBe(0);
  });

  test('36 an invalid date is omitted instead of becoming false evidence', () => {
    const candidate = scoreTransaction(
      document({ merchantName: null, totalAmount: null, cardLast4: null, documentDate: 'not-a-date' }),
      transaction(),
    );
    expect(candidate.availableSignals).toEqual([]);
    expect(candidate.confidence).toBe(0);
  });

  test('37 a received-at fallback caps date evidence at 25% reliability', () => {
    const candidate = scoreTransaction(
      document({ merchantName: null, totalAmount: null, cardLast4: null, dateSource: 'RECEIVED_AT', fieldConfidences: { documentDate: 0.99 } }),
      transaction(),
    );
    expect(candidate.signals.dateFallback).toBe(1);
    expect(candidate.evidenceCoverage).toBe(0.05);
  });

  test('38 Arabic card digits match Latin transaction digits', () => {
    const candidate = scoreTransaction(document({ cardLast4: '٤٤١١' }), transaction());
    expect(candidate.signals.cardLast4).toBe(1);
    expect(candidate.contradictions).toEqual([]);
  });

  test('39 currency comparison trims whitespace and ignores case', () => {
    const candidate = scoreTransaction(document({ currency: ' sar ' }), transaction({ currency: 'SAR' }));
    expect(candidate.signals.amount).toBe(1);
    expect(candidate.contradictions).toEqual([]);
  });

  test('40 invoice identifiers ignore formatting but preserve identity', () => {
    const candidate = scoreTransaction(
      document({ invoiceNumber: ' inv-42 ' }),
      transaction({ invoiceNumber: 'INV 42' }),
    );
    expect(candidate.signals.invoiceNumber).toBe(1);
  });

  test('41 authorization identifiers normalize Arabic digits', () => {
    const candidate = scoreTransaction(
      document({ authorizationCode: '١٢٣-ABC' }),
      transaction({ authorizationCode: '123abc' }),
    );
    expect(candidate.signals.authorizationCode).toBe(1);
  });

  test('42 a strong identifier alone cannot manufacture a match without core evidence', () => {
    const candidate = scoreTransaction(
      document({ merchantName: null, totalAmount: null, documentDate: null, cardLast4: null, vatNumber: '310123456700003' }),
      transaction({ merchantVatNumber: '310123456700003' }),
    );
    expect(candidate.signals.vatNumber).toBe(1);
    expect(candidate.confidence).toBe(0);
    expect(matchDocument(
      document({ merchantName: null, totalAmount: null, documentDate: null, cardLast4: null, vatNumber: '310123456700003' }),
      [transaction({ merchantVatNumber: '310123456700003' })],
    ).outcome).toBe('UNMATCHED');
  });
});

describe('50-case matcher edge matrix — outcomes and ranking (43–50)', () => {
  test('43 no transactions is unmatched', () => {
    expect(matchDocument(document(), [])).toEqual(expect.objectContaining({
      outcome: 'UNMATCHED',
      candidates: [],
      diagnostics: expect.objectContaining({ reason: 'NO_SCOPED_TRANSACTIONS', scopedCandidateCount: 0 }),
    }));
  });

  test('44 a candidate below the 35% display floor is omitted', () => {
    const result = matchDocument(
      document({ merchantName: null, totalAmount: null, cardLast4: null, documentDate: '2025-06-28T08:15:00Z' }),
      [transaction()],
    );
    expect(result).toEqual(expect.objectContaining({
      outcome: 'UNMATCHED',
      candidates: [],
      diagnostics: expect.objectContaining({ reason: 'NO_CANDIDATE_ABOVE_DISPLAY_THRESHOLD' }),
    }));
  });

  test('45 a displayed candidate below the 55% review floor still returns unmatched', () => {
    const result = matchDocument(
      document({ merchantName: null, totalAmount: null, cardLast4: null, documentDate: '2025-06-22T08:15:00Z' }),
      [transaction()],
    );
    expect(result).toEqual(expect.objectContaining({
      outcome: 'UNMATCHED',
      candidates: [],
      diagnostics: expect.objectContaining({ reason: 'TOP_SCORE_BELOW_REVIEW_THRESHOLD' }),
    }));
  });

  test('46 a single complete, contradiction-free candidate auto-matches', () => {
    const result = matchDocument(document(), [transaction()]);
    expect(result.outcome).toBe('AUTO_MATCHED');
    expect(result.candidates[0].confidence).toBe(1);
  });

  test('47 two perfect signals require review because evidence is too sparse', () => {
    const result = matchDocument(
      document({ documentDate: null, cardLast4: null }),
      [transaction()],
    );
    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.candidates[0].availableSignals).toEqual(['amount', 'merchant']);
  });

  test('48 received-at fallback evidence prevents auto-match', () => {
    expect(matchDocument(document({ dateSource: 'RECEIVED_AT' }), [transaction()]).outcome)
      .toBe('NEEDS_REVIEW');
  });

  test('49 an already-confirmed transaction prevents auto-match', () => {
    expect(matchDocument(document(), [transaction({ hasConfirmedDocument: true })]).outcome)
      .toBe('NEEDS_REVIEW');
  });

  test('50 equal top candidates are deterministically ordered and require review', () => {
    const result = matchDocument(document(), [transaction({ id: 9 }), transaction({ id: 3 })]);
    expect(result.outcome).toBe('NEEDS_REVIEW');
    expect(result.candidates.map((candidate) => candidate.transactionId)).toEqual([3, 9]);
  });
});

describe('50-case matcher edge matrix — rarity evidence (51)', () => {
  test('51 merchant and amount rarity are derived from candidate-block frequencies', () => {
    const candidate = scoreTransaction(
      document(),
      transaction({ merchantFrequency: 4, amountFrequency: 9 }),
    );
    expect(candidate.signals.merchantRarity).toBe(0.5);
    expect(candidate.signals.amountRarity).toBe(0.333);
    expect(candidate.confidence).toBeLessThanOrEqual(1);
  });
});
