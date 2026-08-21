export const STATUS_REASON = {
  AUTO_MATCHED: 'AUTO_MATCHED',
  HUMAN_CONFIRMED: 'HUMAN_CONFIRMED',
  AUTO_MATCHED_AFTER_REMATCH: 'AUTO_MATCHED_AFTER_REMATCH',
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  AUTO_MATCH_AUDIT: 'AUTO_MATCH_AUDIT',
  REMATCH_REVIEW: 'REMATCH_REVIEW',
  NO_SCOPED_TRANSACTIONS: 'NO_SCOPED_TRANSACTIONS',
  NO_CANDIDATE_ABOVE_DISPLAY_THRESHOLD: 'NO_CANDIDATE_ABOVE_DISPLAY_THRESHOLD',
  TOP_SCORE_BELOW_REVIEW_THRESHOLD: 'TOP_SCORE_BELOW_REVIEW_THRESHOLD',
  ALL_CANDIDATES_REJECTED: 'ALL_CANDIDATES_REJECTED',
  EXTRACTION_ERROR: 'EXTRACTION_ERROR',
  LOW_QUALITY_EXTRACTION: 'LOW_QUALITY_EXTRACTION',
  CANDIDATE_SCOPING_ERROR: 'CANDIDATE_SCOPING_ERROR',
  PIPELINE_ERROR: 'PIPELINE_ERROR',
  LEGACY_MATCHED: 'LEGACY_MATCHED',
  LEGACY_UNMATCHED: 'LEGACY_UNMATCHED',
  LEGACY_FAILED: 'LEGACY_FAILED',
} as const;

export type StatusReason = typeof STATUS_REASON[keyof typeof STATUS_REASON];

export interface StatusDetails {
  scopedCandidateCount?: number;
  displayedCandidateCount?: number;
  topScore?: number | null;
  displayThreshold?: number;
  reviewThreshold?: number;
  rejectedCandidateCount?: number;
  remainingCandidateCount?: number;
  extractionConfidence?: number;
  errorStage?: 'extraction' | 'scoping' | 'pipeline';
}

export function serializeStatusDetails(details: StatusDetails | null | undefined): string | null {
  return details && Object.keys(details).length > 0 ? JSON.stringify(details) : null;
}

export function parseStatusDetails(value: string | null): StatusDetails {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed as StatusDetails : {};
  } catch {
    return {};
  }
}

export interface StatusExplanationInput {
  status: string;
  statusReason: string | null;
  statusDetails: string | null;
  errorMessage: string | null;
  reviewReason: string | null;
}

export interface StatusExplanation {
  title: string;
  description: string;
  facts: string[];
}

export function explainDocumentStatus(input: StatusExplanationInput): StatusExplanation {
  const details = parseStatusDetails(input.statusDetails);
  const facts = diagnosticFacts(details);
  const reason = input.statusReason ?? input.reviewReason;

  switch (reason) {
    case STATUS_REASON.AUTO_MATCHED:
      return explanation('Matched automatically', 'The top candidate passed every score, evidence, ambiguity, and contradiction safety gate.', facts);
    case STATUS_REASON.HUMAN_CONFIRMED:
      return explanation('Confirmed by a reviewer', 'A finance reviewer selected the transaction after comparing the extracted document with its candidates.', facts);
    case STATUS_REASON.AUTO_MATCHED_AFTER_REMATCH:
      return explanation('Matched after a late transaction arrived', 'The document was previously unmatched, then rematching found a safe transaction after the ledger changed.', facts);
    case STATUS_REASON.AMBIGUOUS_MATCH:
      return explanation('Sent to review because the decision was ambiguous', 'At least one plausible candidate existed, but one or more automatic-match safety gates did not pass.', facts);
    case STATUS_REASON.AUTO_MATCH_AUDIT:
      return explanation('Selected for a quality audit', 'The engine found an automatic match, but the configured audit sample intentionally requested human verification.', facts);
    case STATUS_REASON.REMATCH_REVIEW:
      return explanation('A late candidate needs review', 'Rematching found a plausible transaction, but it was not safe enough to attach automatically.', facts);
    case STATUS_REASON.NO_SCOPED_TRANSACTIONS:
      return explanation('No authorized transaction was available', 'No transaction existed inside the sender’s client/driver scope and applicable date window.', facts);
    case STATUS_REASON.NO_CANDIDATE_ABOVE_DISPLAY_THRESHOLD:
      return explanation('Every candidate was implausible', 'Transactions were available, but even the strongest score was below the minimum candidate display threshold.', facts);
    case STATUS_REASON.TOP_SCORE_BELOW_REVIEW_THRESHOLD:
      return explanation('The best candidate was too weak', 'The strongest candidate was visible to the matcher but did not reach the minimum score required for human review.', facts);
    case STATUS_REASON.ALL_CANDIDATES_REJECTED:
      return explanation('All candidates were rejected', 'A reviewer rejected every proposed transaction, so the document moved from review to unmatched.', facts);
    case STATUS_REASON.EXTRACTION_ERROR:
      return explanation('Document extraction failed', input.errorMessage ?? 'The extractor could not return structured receipt fields.', facts);
    case STATUS_REASON.LOW_QUALITY_EXTRACTION:
      return explanation('Extraction quality was too low', input.errorMessage ?? 'The extracted evidence was incomplete or unreliable, so matching was skipped.', facts);
    case STATUS_REASON.CANDIDATE_SCOPING_ERROR:
      return explanation('Candidate loading failed', input.errorMessage ?? 'The system could not safely load the authorized transaction scope.', facts);
    case STATUS_REASON.PIPELINE_ERROR:
      return explanation('The ingestion pipeline failed', input.errorMessage ?? 'An unexpected error occurred after the document was received.', facts);
    case STATUS_REASON.LEGACY_MATCHED:
      return explanation('Matched before outcome diagnostics were enabled', 'The relationship is confirmed, but this older record does not contain a detailed reason.', facts);
    case STATUS_REASON.LEGACY_UNMATCHED:
      return explanation('Unmatched before outcome diagnostics were enabled', 'This older record has no persisted scoring reason. Re-seed or rematch it to generate diagnostics.', facts);
    case STATUS_REASON.LEGACY_FAILED:
      return explanation('Failed before outcome diagnostics were enabled', input.errorMessage ?? 'This older failure has no structured stage diagnostic.', facts);
    default:
      if (input.status === 'FAILED') return explanation('Processing failed', input.errorMessage ?? 'No structured failure reason was stored.', facts);
      if (input.status === 'UNMATCHED') return explanation('No match was confirmed', 'No plausible transaction is currently attached to this document.', facts);
      if (input.status === 'MATCHED') return explanation('Match confirmed', 'This document is attached to a transaction.', facts);
      return explanation('Lifecycle outcome', 'No additional outcome diagnostic was stored.', facts);
  }
}

function diagnosticFacts(details: StatusDetails): string[] {
  const facts: string[] = [];
  if (details.topScore != null) facts.push(`Best score: ${Math.round(details.topScore * 100)}%`);
  if (details.reviewThreshold != null) facts.push(`Review floor: ${Math.round(details.reviewThreshold * 100)}%`);
  if (details.displayThreshold != null) facts.push(`Candidate floor: ${Math.round(details.displayThreshold * 100)}%`);
  if (details.scopedCandidateCount != null) facts.push(`Transactions checked: ${details.scopedCandidateCount}`);
  if (details.rejectedCandidateCount != null) facts.push(`Candidates rejected: ${details.rejectedCandidateCount}`);
  if (details.extractionConfidence != null) facts.push(`Extraction confidence: ${Math.round(details.extractionConfidence * 100)}%`);
  return facts;
}

function explanation(title: string, description: string, facts: string[]): StatusExplanation {
  return { title, description, facts };
}
