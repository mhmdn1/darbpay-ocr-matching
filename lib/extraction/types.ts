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
  rawText: string;
  extractionConfidence: number;    // 0..1, the OCR's own confidence
}

export interface DocumentExtractor {
  extract(file: Buffer, mimeType: string): Promise<ExtractedDocument>;
}
