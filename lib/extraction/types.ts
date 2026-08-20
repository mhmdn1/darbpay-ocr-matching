export type DocumentType = 'RECEIPT' | 'TAX_INVOICE' | 'UNKNOWN';

export interface ExtractedDocument {
  documentType: DocumentType;
  merchantName: string | null;
  vatNumber: string | null;        // 15-digit KSA VAT number, when present
  totalAmount: number | null;      // minor units (halalas)
  currency: string | null;         // ISO 4217
  documentDate: string | null;     // ISO 8601
  cardLast4: string | null;
  invoiceNumber: string | null;
  authorizationCode?: string | null;
  /** Base64 ZATCA TLV payload when the OCR/vision provider detects a QR code. */
  qrPayload?: string | null;
  /** Per-field OCR reliabilities. Missing values mean "provider did not report it". */
  fieldConfidences?: Partial<Record<
    'merchantName' | 'totalAmount' | 'currency' | 'documentDate' |
    'cardLast4' | 'vatNumber' | 'invoiceNumber' | 'authorizationCode',
    number
  >>;
  rawText: string;
  extractionConfidence: number;    // 0..1, the OCR's own confidence
}

export interface DocumentExtractor {
  extract(file: Buffer, mimeType: string): Promise<ExtractedDocument>;
}
