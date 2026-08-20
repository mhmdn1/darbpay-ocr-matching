/**
 * Maximum-weight one-to-one document/transaction assignment.
 *
 * Batch importers should score plausible edges first, then call this helper so
 * two receipts cannot independently claim the same transaction. Dummy columns
 * allow a document to remain unmatched. Complexity is O(n³).
 */
export interface AssignmentEdge {
  documentId: number;
  transactionId: number;
  score: number;
}

export type GlobalAssignment = AssignmentEdge;

export function assignGlobally(
  edges: AssignmentEdge[],
  minimumScore = 0.55,
): GlobalAssignment[] {
  const documentIds = [...new Set(edges.map((edge) => edge.documentId))].sort((a, b) => a - b);
  const transactionIds = [...new Set(edges.map((edge) => edge.transactionId))].sort((a, b) => a - b);
  if (documentIds.length === 0 || transactionIds.length === 0) return [];

  const scoreByPair = new Map<string, number>();
  for (const edge of edges) {
    const key = `${edge.documentId}:${edge.transactionId}`;
    scoreByPair.set(key, Math.max(scoreByPair.get(key) ?? 0, clamp(edge.score)));
  }

  // One dummy column per document guarantees columns >= rows and permits
  // unmatched output even when every real edge is weak.
  const columnCount = transactionIds.length + documentIds.length;
  const scores = documentIds.map((documentId) =>
    Array.from({ length: columnCount }, (_, column) =>
      column < transactionIds.length
        ? scoreByPair.get(`${documentId}:${transactionIds[column]}`) ?? 0
        : 0,
    ),
  );

  const selectedColumns = hungarianMaximum(scores);
  return selectedColumns.flatMap((column, row) => {
    if (column < 0 || column >= transactionIds.length) return [];
    const score = scores[row][column];
    return score >= minimumScore
      ? [{ documentId: documentIds[row], transactionId: transactionIds[column], score }]
      : [];
  });
}

function hungarianMaximum(scores: number[][]): number[] {
  const rowCount = scores.length;
  const columnCount = scores[0]?.length ?? 0;
  if (columnCount < rowCount) throw new Error('Hungarian assignment requires columns >= rows');

  const u = Array(rowCount + 1).fill(0);
  const v = Array(columnCount + 1).fill(0);
  const p = Array(columnCount + 1).fill(0);
  const way = Array(columnCount + 1).fill(0);

  for (let row = 1; row <= rowCount; row++) {
    p[0] = row;
    let column0 = 0;
    const minValue = Array(columnCount + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array(columnCount + 1).fill(false);
    do {
      used[column0] = true;
      const currentRow = p[column0];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let column = 1; column <= columnCount; column++) {
        if (used[column]) continue;
        const cost = 1 - scores[currentRow - 1][column - 1];
        const reducedCost = cost - u[currentRow] - v[column];
        if (reducedCost < minValue[column]) {
          minValue[column] = reducedCost;
          way[column] = column0;
        }
        if (minValue[column] < delta) {
          delta = minValue[column];
          nextColumn = column;
        }
      }
      for (let column = 0; column <= columnCount; column++) {
        if (used[column]) { u[p[column]] += delta; v[column] -= delta; }
        else minValue[column] -= delta;
      }
      column0 = nextColumn;
    } while (p[column0] !== 0);

    do {
      const previous = way[column0];
      p[column0] = p[previous];
      column0 = previous;
    } while (column0 !== 0);
  }

  const assignment = Array(rowCount).fill(-1);
  for (let column = 1; column <= columnCount; column++) {
    if (p[column] > 0) assignment[p[column] - 1] = column - 1;
  }
  return assignment;
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
