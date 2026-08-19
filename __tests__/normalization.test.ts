import {
  normalizeMerchant,
  scoreMerchant,
  scoreAmount,
  scoreDate,
} from '@/lib/services/transaction-matcher';
import { normalizePhone } from '@/lib/services/document-ingestion';

describe('normalizeMerchant', () => {
  test.each([
    ['ALFANAR FUEL ST 04 RUH',    'ALFANAR FUEL'],
    ['Alfanar Fuel Station',      'ALFANAR FUEL'],
    ['ALFANAR FUEL ST 12 JED',    'ALFANAR FUEL'],
    ['PANDA SUPERMARKET',         'PANDA SUPERMARKET'],
    ['Marhaba Restaurant',        'MARHABA RESTAURANT'],
    ['MARHABA REST AL MALAZ RUH', 'MARHABA REST AL MALAZ'],
    ['STC Payment',               'STC PAYMENT'],
    ['ALRAJHI AUTO SVC RUH',      'ALRAJHI AUTO SVC'],
    // punctuation stripped, whitespace collapsed
    ['Al-Baik  Restaurant, Jeddah', 'AL BAIK RESTAURANT JEDDAH'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeMerchant(input)).toBe(expected);
  });

  test('empty input yields empty output', () => {
    expect(normalizeMerchant('')).toBe('');
    expect(normalizeMerchant('   ')).toBe('');
  });
});

describe('scoreMerchant — real-world messy strings', () => {
  test('acquirer form vs receipt form scores near 1', () => {
    expect(scoreMerchant('ALFANAR FUEL ST 04 RUH', 'Alfanar Fuel Station')).toBe(1);
    expect(scoreMerchant('PETROMIN EXPRESS JED HAMRA', 'Petromin Express')).toBeGreaterThan(0.7);
  });

  test('unrelated merchants score low', () => {
    expect(scoreMerchant('ALFANAR FUEL', 'Panda Supermarket')).toBeLessThan(0.3);
    expect(scoreMerchant('Marhaba Restaurant', 'STC Payment')).toBeLessThan(0.3);
  });

  test('same chain, different branches score similar', () => {
    const a = scoreMerchant('ALFANAR FUEL ST 04 RUH', 'ALFANAR FUEL ST 12 JED');
    expect(a).toBe(1); // both normalize to identical "ALFANAR FUEL"
  });

  test('empty on either side → 0', () => {
    expect(scoreMerchant('', 'Alfanar')).toBe(0);
    expect(scoreMerchant('Alfanar', '')).toBe(0);
  });
});

describe('scoreAmount', () => {
  test('exact match → 1', () => {
    expect(scoreAmount(25000, 25000)).toBe(1);
  });

  test('within ±1 SAR (VAT rounding) → 1', () => {
    expect(scoreAmount(25050, 25000)).toBe(1);
    expect(scoreAmount(24950, 25000)).toBe(1);
  });

  test('tip case — receipt smaller by up to 30%', () => {
    // Receipt 57.50, charge 63.25 → diff/charge ~9%
    const s = scoreAmount(5750, 6325);
    expect(s).toBeGreaterThan(0.7);
    expect(s).toBeLessThan(1);
  });

  test('receipt smaller by more than 30% → 0', () => {
    expect(scoreAmount(1000, 10000)).toBe(0);
  });

  test('receipt larger than charge (only tiny rounding overshoot allowed)', () => {
    expect(scoreAmount(6450, 6325)).toBe(0.9); // ~1.9% overshoot, above exact band
    expect(scoreAmount(7000, 6325)).toBe(0);   // ~10% overshoot — implausible
  });

  test('zero or negative amounts → 0', () => {
    expect(scoreAmount(0, 100)).toBe(0);
    expect(scoreAmount(-100, 100)).toBe(0);
    expect(scoreAmount(100, 0)).toBe(0);
  });
});

describe('scoreDate', () => {
  const base = new Date('2025-06-14T08:00:00Z');

  test('same day → 1', () => {
    expect(scoreDate(base, base)).toBe(1);
    expect(scoreDate(new Date('2025-06-14T23:00:00Z'), base)).toBe(1);
  });

  test('1 day apart still very close', () => {
    const d = new Date('2025-06-15T08:00:00Z');
    expect(scoreDate(d, base)).toBeGreaterThan(0.95);
  });

  test('3 days apart → around 0.7', () => {
    const d = new Date('2025-06-17T08:00:00Z');
    expect(scoreDate(d, base)).toBeCloseTo(0.7, 1);
  });

  test('14 days apart → close to 0.2', () => {
    const d = new Date('2025-06-28T08:00:00Z');
    expect(scoreDate(d, base)).toBeLessThan(0.3);
  });

  test('beyond 14 days → 0', () => {
    const d = new Date('2025-07-14T08:00:00Z');
    expect(scoreDate(d, base)).toBe(0);
  });

  test('order-independent (absolute difference)', () => {
    const d = new Date('2025-06-12T08:00:00Z');
    expect(scoreDate(d, base)).toBe(scoreDate(base, d));
  });
});

describe('normalizePhone', () => {
  test.each([
    ['966551234567',       '+966551234567'],
    ['+966551234567',      '+966551234567'],
    ['+966 55 123 4567',   '+966551234567'],
    ['(966) 55-123-4567',  '+966551234567'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  test('empty input passes through unchanged', () => {
    expect(normalizePhone('')).toBe('');
  });
});
