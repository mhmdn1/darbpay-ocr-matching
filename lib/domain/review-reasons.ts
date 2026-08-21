export const REJECTION_REASONS = [
  'NOT_SAME_PURCHASE',
  'WRONG_AMOUNT',
  'WRONG_MERCHANT',
  'WRONG_CARD',
  'WRONG_DATE',
  'DUPLICATE_TRANSACTION',
  'EXTRACTION_ERROR',
] as const;

export type RejectionReason = typeof REJECTION_REASONS[number];

export const REJECTION_REASON_LABELS: Record<RejectionReason, string> = {
  NOT_SAME_PURCHASE: 'Not the same purchase',
  WRONG_AMOUNT: 'Wrong amount',
  WRONG_MERCHANT: 'Wrong merchant',
  WRONG_CARD: 'Wrong card',
  WRONG_DATE: 'Wrong date',
  DUPLICATE_TRANSACTION: 'Transaction already used',
  EXTRACTION_ERROR: 'Receipt extraction is wrong',
};
