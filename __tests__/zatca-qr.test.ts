import { decodeZatcaQr, enrichWithZatcaQr } from '@/lib/extraction/zatca-qr';

function tlv(entries: Array<[number, string]>): string {
  return Buffer.concat(entries.map(([tag, value]) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
  })).toString('base64');
}

describe('ZATCA QR extraction', () => {
  const payload = tlv([
    [1, 'متجر النور'], [2, '310123456700003'], [3, '2025-06-14T08:00:00Z'], [4, '250.50'], [5, '32.67'],
  ]);

  test('decodes mandatory TLV tags into typed fields', () => {
    expect(decodeZatcaQr(payload)).toEqual(expect.objectContaining({
      sellerName: 'متجر النور', vatNumber: '310123456700003', totalAmount: 25050, vatAmount: 3267,
    }));
  });

  test('fills missing OCR fields without overwriting visible OCR', () => {
    const enriched = enrichWithZatcaQr({
      documentType: 'TAX_INVOICE', merchantName: 'Visible merchant', vatNumber: null,
      totalAmount: null, currency: null, documentDate: null, cardLast4: null,
      invoiceNumber: null, rawText: '', extractionConfidence: 0.9, qrPayload: payload,
    });
    expect(enriched.merchantName).toBe('Visible merchant');
    expect(enriched.vatNumber).toBe('310123456700003');
    expect(enriched.totalAmount).toBe(25050);
    expect(enriched.currency).toBe('SAR');
  });

  test('rejects malformed payloads', () => {
    expect(decodeZatcaQr('not-valid-base64')).toBeNull();
  });
});
