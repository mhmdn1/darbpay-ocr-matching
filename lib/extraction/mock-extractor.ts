import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocumentExtractor, ExtractedDocument } from './types';

interface FixtureSpec {
  file: string;
  extracted: ExtractedDocument;
}

/**
 * Extraction results keyed by fixture filename. Each entry describes what a
 * hypothetical OCR provider would return for that document. The
 * `MockExtractor` builds a sha256 → ExtractedDocument index at construction
 * time so `extract(buffer)` becomes a pure lookup by content hash.
 */
export const FIXTURE_EXTRACTIONS: FixtureSpec[] = [
  {
    // Edge case #1 — exact match: unique amount + merchant + card + date.
    // Seed transaction #4 (Al Rashed → Alrajhi Auto SAR 1200, card 4411).
    file: 'alrajhi-auto-tax-invoice.txt',
    extracted: {
      documentType: 'TAX_INVOICE',
      merchantName: 'Alrajhi Auto Service',
      vatNumber: '300123456700003',
      totalAmount: 120000,
      currency: 'SAR',
      documentDate: '2025-06-20T10:04:00Z',
      cardLast4: '4411',
      invoiceNumber: 'AR-INV-99812',
      rawText: 'TAX INVOICE — Alrajhi Auto Service Co. LLC — TOTAL DUE SAR 1200.00 — card 4411',
      extractionConfidence: 0.94,
    },
  },
  {
    // Edge case #2 — ambiguous. Two seed transactions at Alfanar Fuel on the
    // same day for the same amount and card; receipt does not show the card.
    file: 'alfanar-fuel-ambiguous.txt',
    extracted: {
      documentType: 'RECEIPT',
      merchantName: 'ALFANAR FUEL STATION',
      vatNumber: null,
      totalAmount: 25000,
      currency: 'SAR',
      documentDate: '2025-06-14T08:22:00Z',
      cardLast4: null,
      invoiceNumber: '20250614-3',
      rawText: 'ALFANAR FUEL STATION — TOTAL SAR 250.00 — card last 4 not shown',
      extractionConfidence: 0.78,
    },
  },
  {
    // Edge case #3 — tip. Receipt total 57.50 vs charged 63.25.
    file: 'marhaba-restaurant-tip.txt',
    extracted: {
      documentType: 'RECEIPT',
      merchantName: 'Marhaba Restaurant',
      vatNumber: null,
      totalAmount: 5750,
      currency: 'SAR',
      documentDate: '2025-06-17T12:31:00Z',
      cardLast4: '4411',
      invoiceNumber: '44-8817',
      rawText: 'Marhaba Restaurant — Al Malaz — TOTAL SAR 57.50 — card *4411',
      extractionConfidence: 0.88,
    },
  },
  {
    // Edge case #5 — orphan. Zamil Steel invoice with no matching transaction.
    file: 'zamil-steel-orphan.txt',
    extracted: {
      documentType: 'TAX_INVOICE',
      merchantName: 'Zamil Steel Industries',
      vatNumber: '300777889900003',
      totalAmount: 100000,
      currency: 'SAR',
      documentDate: '2025-06-14T00:00:00Z',
      cardLast4: null,
      invoiceNumber: 'ZS-2025-4471',
      rawText: 'ZAMIL STEEL INDUSTRIES — TOTAL SAR 1000.00 — BANK TRANSFER',
      extractionConfidence: 0.91,
    },
  },
  {
    // Edge case #6 — garbage. Extractor could not read anything useful.
    file: 'garbage-blurry.txt',
    extracted: {
      documentType: 'UNKNOWN',
      merchantName: null,
      vatNumber: null,
      totalAmount: null,
      currency: null,
      documentDate: null,
      cardLast4: null,
      invoiceNumber: null,
      rawText: '',
      extractionConfidence: 0.05,
    },
  },
  {
    // Second client happy path. Petromin receipt matches seed transaction #8.
    file: 'petromin-najm-exact.txt',
    extracted: {
      documentType: 'RECEIPT',
      merchantName: 'Petromin Express',
      vatNumber: null,
      totalAmount: 30000,
      currency: 'SAR',
      documentDate: '2025-06-14T08:03:00Z',
      cardLast4: '8823',
      invoiceNumber: 'PX-20250614-118',
      rawText: 'PETROMIN EXPRESS — Jeddah — TOTAL SAR 300.00 — card *8823',
      extractionConfidence: 0.92,
    },
  },
  {
    // Demo: a second scan targets a transaction that already owns a confirmed
    // document. It must stay in review even though the receipt itself is exact.
    file: 'alrajhi-duplicate-receipt.txt',
    extracted: {
      documentType: 'TAX_INVOICE',
      merchantName: 'Alrajhi Auto Service',
      vatNumber: '300123456700003',
      totalAmount: 120000,
      currency: 'SAR',
      documentDate: '2025-06-20T10:04:00Z',
      cardLast4: '4411',
      invoiceNumber: 'AR-COPY-99812',
      rawText: 'ALRAJHI AUTO SERVICE — DUPLICATE COPY — TOTAL SAR 1200.00 — card 4411',
      extractionConfidence: 0.96,
    },
  },
  {
    // Demo: no purchase date and no card digits. Ingestion uses receivedAt as
    // weak date evidence, which is deliberately forbidden from auto-matching.
    file: 'stc-missing-date.txt',
    extracted: {
      documentType: 'RECEIPT',
      merchantName: 'STC Payment',
      vatNumber: null,
      totalAmount: 50000,
      currency: 'SAR',
      documentDate: null,
      cardLast4: null,
      invoiceNumber: 'STC-MISSING-DATE-1',
      fieldConfidences: { merchantName: 0.96, totalAmount: 0.98 },
      rawText: 'STC PAYMENT — TOTAL SAR 500.00 — purchase date and card not legible',
      extractionConfidence: 0.76,
    },
  },
  {
    // Demo: the same chain, amount, day, and card appear at two branches. City
    // and branch context rank Riyadh first, but the small gap still needs review.
    file: 'nour-cafe-branch-choice.txt',
    extracted: {
      documentType: 'RECEIPT',
      merchantName: 'NOUR CAFE BR 04 RUH',
      vatNumber: null,
      totalAmount: 8750,
      currency: 'SAR',
      documentDate: '2025-06-22T08:20:00Z',
      cardLast4: '4411',
      invoiceNumber: 'NC-220625-04',
      rawText: 'NOUR CAFE BR 04 RUH — TOTAL SAR 87.50 — card 4411',
      extractionConfidence: 0.93,
    },
  },
  {
    // Demo: every identity signal looks plausible except a confidently read
    // USD currency against a SAR transaction. The contradiction leaves it unmatched.
    file: 'panda-currency-conflict.txt',
    extracted: {
      documentType: 'RECEIPT',
      merchantName: 'Panda Supermarket',
      vatNumber: null,
      totalAmount: 42000,
      currency: 'USD',
      documentDate: '2025-06-18T18:14:00Z',
      cardLast4: '4411',
      invoiceNumber: 'PANDA-USD-42',
      fieldConfidences: { currency: 0.99, totalAmount: 0.98 },
      rawText: 'PANDA SUPERMARKET — TOTAL USD 420.00 — card 4411',
      extractionConfidence: 0.95,
    },
  },
];

export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Fixture-backed OCR mock. Loads all fixture files at construction, hashes
 * each, and builds a sha256 → ExtractedDocument map. `extract(buffer)`
 * hashes the input and returns the mapped extraction, or a
 * documentType='UNKNOWN' fallback for files the mock does not recognize.
 *
 * Async construction so we don't do blocking I/O on the module level.
 */
export class MockExtractor implements DocumentExtractor {
  private readonly index: Map<string, ExtractedDocument>;

  private constructor(index: Map<string, ExtractedDocument>) {
    this.index = index;
  }

  static async create(fixturesDir?: string): Promise<MockExtractor> {
    const dir = fixturesDir ?? join(process.cwd(), 'fixtures', 'documents');
    const map = new Map<string, ExtractedDocument>();
    for (const spec of FIXTURE_EXTRACTIONS) {
      const bytes = await readFile(join(dir, spec.file));
      map.set(hashBuffer(bytes), spec.extracted);
    }
    return new MockExtractor(map);
  }

  async extract(file: Buffer, mimeType: string): Promise<ExtractedDocument> {
    void mimeType; // The fixture hash is format-independent; real extractors use this.
    const hit = this.index.get(hashBuffer(file));
    if (hit) return hit;
    // Unknown file — a real OCR would return whatever it saw. We return
    // low-confidence UNKNOWN so ingestion routes it to FAILED without
    // crashing the pipeline.
    return {
      documentType: 'UNKNOWN',
      merchantName: null,
      vatNumber: null,
      totalAmount: null,
      currency: null,
      documentDate: null,
      cardLast4: null,
      invoiceNumber: null,
      rawText: '',
      extractionConfidence: 0,
    };
  }
}
