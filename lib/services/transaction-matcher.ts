/**
 * Transaction matcher — pure function.
 *
 * Given a document's extracted fields and a set of candidate transactions
 * (already scoped by sender at the caller), score each transaction on four
 * signals and decide whether the result is auto-matchable, needs a human,
 * or should be dropped. All scoring parameters live in `MATCHER_CONFIG` at
 * the top of this file; rationale lives in IMPLEMENTATION.md.
 */

// ── Input / output types ────────────────────────────────────────────────────

export interface ExtractedFields {
  documentType: 'RECEIPT' | 'TAX_INVOICE' | 'UNKNOWN';
  merchantName: string | null;
  totalAmount: number | null;   // minor units
  currency: string | null;
  documentDate: string | null;  // ISO 8601
  cardLast4: string | null;
}

export interface CandidateTransaction {
  id: number;
  cardLast4: string;
  merchantName: string;
  amount: number;               // minor units
  currency: string;
  transactionAt: Date;
  /** True when a CONFIRMED or AUTO_CONFIRMED match already exists. */
  hasConfirmedDocument: boolean;
}

export type MatchOutcome = 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'UNMATCHED';

export interface MatchCandidate {
  transactionId: number;
  confidence: number;                 // 0..1
  signals: Record<string, number>;    // per-signal 0..1 breakdown, for explainability
}

export interface MatchResult {
  outcome: MatchOutcome;
  candidates: MatchCandidate[];       // ranked, best first
}

// ── Config (tunable — justified in IMPLEMENTATION.md) ───────────────────────

export const MATCHER_CONFIG = {
  weights: {
    amount:    0.30,
    date:      0.20,
    merchant:  0.25,
    cardLast4: 0.25,
  },
  thresholds: {
    /** Top candidate must reach this to be considered at all. */
    review:        0.55,
    /** Top candidate must reach this AND lead the runner-up by `autoMatchGap` to auto-match. */
    autoMatch:     0.82,
    autoMatchGap:  0.12,
    /** Second candidate within this margin of the top => review (near-tie). */
    tieGap:        0.05,
  },
  amount: {
    exactHalalas: 100,          // ±1 SAR treated as exact (VAT rounding)
    tipMaxRatio:  0.30,         // receipt up to 30% less than tx allowed as tip
  },
  date: {
    sameDayHours: 24,
    nearDays:     3,
    maxDays:      14,
  },
  cardLast4: {
    /** Multiplier applied to overall confidence when receipt shows a card that does not match. */
    mismatchPenalty: 0.25,
  },
  /** Cap the candidates array returned for review. */
  maxCandidates: 5,
} as const;

// ── Public entry point ──────────────────────────────────────────────────────

export function matchDocument(
  doc: ExtractedFields,
  transactions: CandidateTransaction[],
): MatchResult {
  if (transactions.length === 0) {
    return { outcome: 'UNMATCHED', candidates: [] };
  }

  const scored: MatchCandidate[] = transactions
    .map((tx) => scoreTransaction(doc, tx))
    .filter((c) => c.confidence > 0);

  scored.sort((a, b) => b.confidence - a.confidence);

  const trimmed = scored.slice(0, MATCHER_CONFIG.maxCandidates);
  const top = trimmed[0];

  if (!top || top.confidence < MATCHER_CONFIG.thresholds.review) {
    return { outcome: 'UNMATCHED', candidates: [] };
  }

  const second = trimmed[1];
  const topTx = transactions.find((t) => t.id === top.transactionId)!;
  const nearTie = second && (top.confidence - second.confidence) < MATCHER_CONFIG.thresholds.tieGap;
  const gap = second ? top.confidence - second.confidence : top.confidence;

  const canAutoMatch =
    top.confidence >= MATCHER_CONFIG.thresholds.autoMatch &&
    gap >= MATCHER_CONFIG.thresholds.autoMatchGap &&
    !topTx.hasConfirmedDocument &&
    !nearTie;

  if (canAutoMatch) {
    return { outcome: 'AUTO_MATCHED', candidates: trimmed };
  }

  return { outcome: 'NEEDS_REVIEW', candidates: trimmed };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function scoreTransaction(doc: ExtractedFields, tx: CandidateTransaction): MatchCandidate {
  const signals: Record<string, number> = {};
  const weightsAvailable: number[] = [];
  const weightedScores: number[] = [];

  // Amount
  if (doc.totalAmount != null) {
    if (doc.currency && tx.currency && doc.currency !== tx.currency) {
      signals.amount = 0;
    } else {
      signals.amount = scoreAmount(doc.totalAmount, tx.amount);
    }
    weightsAvailable.push(MATCHER_CONFIG.weights.amount);
    weightedScores.push(signals.amount * MATCHER_CONFIG.weights.amount);
  }

  // Date
  if (doc.documentDate) {
    const parsed = Date.parse(doc.documentDate);
    if (!Number.isNaN(parsed)) {
      signals.date = scoreDate(new Date(parsed), tx.transactionAt);
      weightsAvailable.push(MATCHER_CONFIG.weights.date);
      weightedScores.push(signals.date * MATCHER_CONFIG.weights.date);
    }
  }

  // Merchant
  if (doc.merchantName) {
    signals.merchant = scoreMerchant(doc.merchantName, tx.merchantName);
    weightsAvailable.push(MATCHER_CONFIG.weights.merchant);
    weightedScores.push(signals.merchant * MATCHER_CONFIG.weights.merchant);
  }

  // Card last 4
  let cardMismatch = false;
  if (doc.cardLast4) {
    const match = doc.cardLast4 === tx.cardLast4;
    signals.cardLast4 = match ? 1 : 0;
    weightsAvailable.push(MATCHER_CONFIG.weights.cardLast4);
    weightedScores.push(signals.cardLast4 * MATCHER_CONFIG.weights.cardLast4);
    if (!match) cardMismatch = true;
  }

  const totalWeight = weightsAvailable.reduce((s, w) => s + w, 0);
  const rawConfidence = totalWeight > 0 ? sum(weightedScores) / totalWeight : 0;
  const confidence = cardMismatch
    ? rawConfidence * MATCHER_CONFIG.cardLast4.mismatchPenalty
    : rawConfidence;

  return {
    transactionId: tx.id,
    confidence: round3(confidence),
    signals: mapValues(signals, round3),
  };
}

// ── Individual signal scorers ───────────────────────────────────────────────

/** Amount score handles VAT rounding and restaurant-tip cases. */
export function scoreAmount(docAmount: number, txAmount: number): number {
  if (docAmount <= 0 || txAmount <= 0) return 0;
  const diff = Math.abs(docAmount - txAmount);
  if (diff <= MATCHER_CONFIG.amount.exactHalalas) return 1;

  // Tip case: receipt total is smaller than card charge (customer added a tip).
  if (docAmount < txAmount) {
    const ratio = diff / txAmount;
    if (ratio <= MATCHER_CONFIG.amount.tipMaxRatio) {
      // 0% diff -> 1.0, tipMaxRatio -> 0.5, beyond -> 0
      return Math.max(0, 1 - (ratio / MATCHER_CONFIG.amount.tipMaxRatio) * 0.5);
    }
    return 0;
  }

  // Receipt larger than charge — small rounding tolerance only.
  const ratio = diff / txAmount;
  if (ratio <= 0.02) return 0.9; // 2% (rare VAT rounding overshoot)
  return 0;
}

/** Date score decays with distance in days. */
export function scoreDate(docDate: Date, txDate: Date): number {
  const hours = Math.abs(docDate.getTime() - txDate.getTime()) / (1000 * 60 * 60);
  if (hours <= MATCHER_CONFIG.date.sameDayHours) return 1;
  const days = hours / 24;
  if (days <= MATCHER_CONFIG.date.nearDays) {
    return 1 - ((days - 1) / (MATCHER_CONFIG.date.nearDays - 1)) * 0.3; // 1.0 → 0.7
  }
  if (days <= MATCHER_CONFIG.date.maxDays) {
    return 0.7 - ((days - MATCHER_CONFIG.date.nearDays) /
      (MATCHER_CONFIG.date.maxDays - MATCHER_CONFIG.date.nearDays)) * 0.5; // 0.7 → 0.2
  }
  return 0;
}

/**
 * Merchant similarity. Normalizes both sides (strip noise words like
 * "STATION", branch numbers, city codes) and returns a Dice coefficient
 * on character bigrams — cheap, dependency-free, works well on short strings.
 */
export function scoreMerchant(docName: string, txName: string): number {
  const a = normalizeMerchant(docName);
  const b = normalizeMerchant(txName);
  if (!a || !b) return 0;
  if (a === b) return 1;

  // Token overlap contributes half the score — catches "Alfanar Fuel Station"
  // vs "ALFANAR FUEL ST 04 RUH" strongly even when bigrams disagree on tails.
  const tokenScore = jaccardTokens(a, b);
  const bigramScore = diceBigrams(a, b);
  return round3(0.5 * tokenScore + 0.5 * bigramScore);
}

// ── Merchant normalization ──────────────────────────────────────────────────

const MERCHANT_NOISE_TOKENS = new Set([
  'ST', 'STR', 'STA', 'STATION', 'STATIONS', 'STORE', 'STORES',
  'BR', 'BRANCH', 'CO', 'LTD', 'LLC', 'INC', 'POS', 'PLC',
  'THE', 'AND', 'OF', 'FOR',
  // KSA city codes seen on acquirer strings
  'RUH', 'JED', 'DMM', 'MED', 'MEC', 'AHD', 'KHR', 'TAI',
]);

export function normalizeMerchant(name: string): string {
  return name
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip diacritics
    .replace(/[^A-Z0-9\s]/g, ' ')         // punctuation → space
    .split(/\s+/)
    .filter((tok) => tok.length > 0)
    .filter((tok) => !/^\d+$/.test(tok))  // drop pure numbers ("04")
    .filter((tok) => !MERCHANT_NOISE_TOKENS.has(tok))
    .join(' ')
    .trim();
}

function jaccardTokens(a: string, b: string): number {
  const at = new Set(a.split(' '));
  const bt = new Set(b.split(' '));
  if (at.size === 0 || bt.size === 0) return 0;
  let inter = 0;
  for (const t of at) if (bt.has(t)) inter++;
  return inter / (at.size + bt.size - inter);
}

function diceBigrams(a: string, b: string): number {
  const bigrams = (s: string): string[] => {
    const compact = s.replace(/\s+/g, '');
    const out: string[] = [];
    for (let i = 0; i < compact.length - 1; i++) out.push(compact.slice(i, i + 2));
    return out;
  };
  const ab = bigrams(a);
  const bb = bigrams(b);
  if (ab.length === 0 || bb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of ab) counts.set(g, (counts.get(g) ?? 0) + 1);
  let overlap = 0;
  for (const g of bb) {
    const c = counts.get(g);
    if (c && c > 0) {
      overlap++;
      counts.set(g, c - 1);
    }
  }
  return (2 * overlap) / (ab.length + bb.length);
}

// ── tiny utils ──────────────────────────────────────────────────────────────

function sum(xs: number[]): number { return xs.reduce((a, b) => a + b, 0); }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }
function mapValues<T, U>(obj: Record<string, T>, fn: (v: T) => U): Record<string, U> {
  const out: Record<string, U> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out;
}
