import { assignGlobally } from '@/lib/services/global-assignment';

describe('assignGlobally', () => {
  test('finds the maximum total score instead of greedily consuming a shared transaction', () => {
    const result = assignGlobally([
      { documentId: 1, transactionId: 10, score: 0.90 },
      { documentId: 1, transactionId: 20, score: 0.89 },
      { documentId: 2, transactionId: 10, score: 0.88 },
      { documentId: 2, transactionId: 20, score: 0.20 },
    ]);
    expect(result).toEqual(expect.arrayContaining([
      { documentId: 1, transactionId: 20, score: 0.89 },
      { documentId: 2, transactionId: 10, score: 0.88 },
    ]));
  });

  test('leaves weak documents unmatched', () => {
    expect(assignGlobally([{ documentId: 1, transactionId: 10, score: 0.4 }])).toEqual([]);
  });
});
