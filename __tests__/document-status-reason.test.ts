import {
  explainDocumentStatus,
  serializeStatusDetails,
  STATUS_REASON,
} from '@/lib/services/document-status-reason';

describe('document status explanations', () => {
  test('explains a weak unmatched candidate with its persisted thresholds', () => {
    const explanation = explainDocumentStatus({
      status: 'UNMATCHED',
      statusReason: STATUS_REASON.TOP_SCORE_BELOW_REVIEW_THRESHOLD,
      statusDetails: serializeStatusDetails({
        topScore: 0.44,
        reviewThreshold: 0.55,
        scopedCandidateCount: 5,
      }),
      errorMessage: null,
      reviewReason: null,
    });

    expect(explanation.title).toBe('The best candidate was too weak');
    expect(explanation.facts).toEqual(expect.arrayContaining([
      'Best score: 44%',
      'Review floor: 55%',
      'Transactions checked: 5',
    ]));
  });

  test('uses the stored failure message for extraction failures', () => {
    const explanation = explainDocumentStatus({
      status: 'FAILED',
      statusReason: STATUS_REASON.EXTRACTION_ERROR,
      statusDetails: null,
      errorMessage: 'extraction: timed out',
      reviewReason: null,
    });

    expect(explanation.title).toBe('Document extraction failed');
    expect(explanation.description).toBe('extraction: timed out');
  });

  test('falls back safely for old unmatched records', () => {
    expect(explainDocumentStatus({
      status: 'UNMATCHED',
      statusReason: null,
      statusDetails: '{not-json',
      errorMessage: null,
      reviewReason: null,
    }).title).toBe('No match was confirmed');
  });
});
