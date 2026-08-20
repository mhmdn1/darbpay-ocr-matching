import type { ExtractedDocument } from '@/lib/extraction/types';

export interface ZatcaQrFields {
  sellerName?: string;
  vatNumber?: string;
  timestamp?: string;
  totalAmount?: number;
  vatAmount?: number;
}

/** Decode the mandatory tags in a Saudi ZATCA phase-1 TLV QR payload. */
export function decodeZatcaQr(payload: string): ZatcaQrFields | null {
  try {
    const bytes = Buffer.from(payload.trim(), 'base64');
    if (bytes.length < 2) return null;
    const values = new Map<number, string>();
    for (let offset = 0; offset + 2 <= bytes.length;) {
      const tag = bytes[offset++];
      const length = bytes[offset++];
      if (offset + length > bytes.length) return null;
      values.set(tag, bytes.subarray(offset, offset + length).toString('utf8'));
      offset += length;
    }
    const totalAmount = decimalToMinor(values.get(4));
    const vatAmount = decimalToMinor(values.get(5));
    return {
      sellerName: values.get(1),
      vatNumber: values.get(2),
      timestamp: validIso(values.get(3)),
      totalAmount,
      vatAmount,
    };
  } catch { return null; }
}

/** QR values fill missing OCR fields; visible OCR remains the primary source. */
export function enrichWithZatcaQr(document: ExtractedDocument): ExtractedDocument {
  if (!document.qrPayload) return document;
  const qr = decodeZatcaQr(document.qrPayload);
  if (!qr) return document;
  return {
    ...document,
    merchantName: document.merchantName ?? qr.sellerName ?? null,
    vatNumber: document.vatNumber ?? qr.vatNumber ?? null,
    totalAmount: document.totalAmount ?? qr.totalAmount ?? null,
    documentDate: document.documentDate ?? qr.timestamp ?? null,
    currency: document.currency ?? (qr.totalAmount != null ? 'SAR' : null),
    fieldConfidences: {
      ...document.fieldConfidences,
      ...(document.merchantName == null && qr.sellerName ? { merchantName: 0.99 } : {}),
      ...(document.vatNumber == null && qr.vatNumber ? { vatNumber: 0.99 } : {}),
      ...(document.totalAmount == null && qr.totalAmount != null ? { totalAmount: 0.99 } : {}),
      ...(document.documentDate == null && qr.timestamp ? { documentDate: 0.99 } : {}),
    },
  };
}

function decimalToMinor(value: string | undefined): number | undefined {
  if (!value || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return undefined;
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : undefined;
}

function validIso(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}
