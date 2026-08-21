/**
 * Explainable, deterministic transaction matcher.
 *
 * `confidence` is a heuristic ranking score, not a calibrated probability.
 * The offline evaluation module can calibrate it once reviewer-labelled data
 * exists. Until then, evidence coverage and contradictions gate automation.
 */

export interface FieldConfidences {
  merchantName?: number;
  totalAmount?: number;
  currency?: number;
  documentDate?: number;
  cardLast4?: number;
  vatNumber?: number;
  invoiceNumber?: number;
  authorizationCode?: number;
}

export interface ExtractedFields {
  documentType: 'RECEIPT' | 'TAX_INVOICE' | 'UNKNOWN';
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: string | null;
  dateSource?: 'DOCUMENT' | 'RECEIVED_AT';
  cardLast4: string | null;
  vatNumber?: string | null;
  invoiceNumber?: string | null;
  authorizationCode?: string | null;
  fieldConfidences?: FieldConfidences;
}

export interface CandidateTransaction {
  id: number;
  cardLast4: string;
  merchantName: string;
  amount: number;
  currency: string;
  transactionAt: Date;
  hasConfirmedDocument: boolean;
  merchantVatNumber?: string | null;
  invoiceNumber?: string | null;
  authorizationCode?: string | null;
  merchantCategory?: string | null;
  merchantCity?: string | null;
  /** Frequencies inside the tenant/date candidate block. */
  merchantFrequency?: number;
  amountFrequency?: number;
  /** Human-confirmed receipt descriptors for this canonical transaction merchant. */
  merchantAliases?: string[];
}

export type MatchOutcome = 'AUTO_MATCHED' | 'NEEDS_REVIEW' | 'UNMATCHED';

export interface MatchCandidate {
  transactionId: number;
  /** Similarity across the fields that were available on the document. */
  confidence: number;
  /** Conservative automation score: similarity discounted by missing evidence. */
  decisionConfidence: number;
  signals: Record<string, number>;
  evidenceCoverage: number;
  availableSignals: string[];
  contradictions: string[];
}

export interface MatchResult {
  outcome: MatchOutcome;
  candidates: MatchCandidate[];
  diagnostics?: MatchDiagnostics;
}

export interface MatchDiagnostics {
  reason: 'NO_SCOPED_TRANSACTIONS' | 'NO_CANDIDATE_ABOVE_DISPLAY_THRESHOLD' | 'TOP_SCORE_BELOW_REVIEW_THRESHOLD';
  scopedCandidateCount: number;
  displayedCandidateCount: number;
  topScore: number | null;
  displayThreshold: number;
  reviewThreshold: number;
}

export const MATCHER_CONFIG = {
  weights: { amount: 0.30, date: 0.20, merchant: 0.25, cardLast4: 0.25 },
  thresholds: {
    review: 0.55,
    candidateDisplay: 0.35,
    autoMatch: 0.82,
    autoMatchGap: 0.12,
    minAutoEvidenceCoverage: 0.70,
    minAutoSignals: 3,
  },
  amount: {
    absoluteToleranceHalalas: 100,
    relativeTolerance: 0.002,
    tipMaxRatio: 0.30,
  },
  date: { nearDays: 3, maxDays: 14, timezone: 'Asia/Riyadh' },
  extraction: { hardContradictionConfidence: 0.80 },
  uniqueness: { merchantBonus: 0.02, amountBonus: 0.01 },
  maxCandidates: 5,
} as const;

export const MATCHER_VERSION = 'heuristic-v2' as const;

export function matchDocument(doc: ExtractedFields, transactions: CandidateTransaction[]): MatchResult {
  if (transactions.length === 0) {
    return {
      outcome: 'UNMATCHED',
      candidates: [],
      diagnostics: unmatchedDiagnostics('NO_SCOPED_TRANSACTIONS', 0, 0, null),
    };
  }

  const allScored = transactions
    .map((tx) => scoreTransaction(doc, tx))
    .sort((a, b) => b.decisionConfidence - a.decisionConfidence || b.confidence - a.confidence || a.transactionId - b.transactionId);
  const scored = allScored
    .filter((candidate) => candidate.decisionConfidence >= MATCHER_CONFIG.thresholds.candidateDisplay)
    .slice(0, MATCHER_CONFIG.maxCandidates);

  const top = scored[0];
  if (!top) {
    return {
      outcome: 'UNMATCHED',
      candidates: [],
      diagnostics: unmatchedDiagnostics(
        'NO_CANDIDATE_ABOVE_DISPLAY_THRESHOLD',
        transactions.length,
        0,
        allScored[0]?.decisionConfidence ?? null,
      ),
    };
  }
  if (top.decisionConfidence < MATCHER_CONFIG.thresholds.review) {
    return {
      outcome: 'UNMATCHED',
      candidates: [],
      diagnostics: unmatchedDiagnostics(
        'TOP_SCORE_BELOW_REVIEW_THRESHOLD',
        transactions.length,
        scored.length,
        top.decisionConfidence,
      ),
    };
  }

  const second = scored[1];
  const gap = second ? top.decisionConfidence - second.decisionConfidence : top.decisionConfidence;
  const topTx = transactions.find((tx) => tx.id === top.transactionId)!;
  const canAutoMatch =
    top.decisionConfidence >= MATCHER_CONFIG.thresholds.autoMatch &&
    gap >= MATCHER_CONFIG.thresholds.autoMatchGap &&
    top.evidenceCoverage >= MATCHER_CONFIG.thresholds.minAutoEvidenceCoverage &&
    top.availableSignals.length >= MATCHER_CONFIG.thresholds.minAutoSignals &&
    doc.dateSource !== 'RECEIVED_AT' &&
    top.contradictions.length === 0 &&
    !topTx.hasConfirmedDocument;

  return { outcome: canAutoMatch ? 'AUTO_MATCHED' : 'NEEDS_REVIEW', candidates: scored };
}

function unmatchedDiagnostics(
  reason: MatchDiagnostics['reason'],
  scopedCandidateCount: number,
  displayedCandidateCount: number,
  topScore: number | null,
): MatchDiagnostics {
  return {
    reason,
    scopedCandidateCount,
    displayedCandidateCount,
    topScore,
    displayThreshold: MATCHER_CONFIG.thresholds.candidateDisplay,
    reviewThreshold: MATCHER_CONFIG.thresholds.review,
  };
}

export function scoreTransaction(doc: ExtractedFields, tx: CandidateTransaction): MatchCandidate {
  const signals: Record<string, number> = {};
  const availableSignals: string[] = [];
  const contradictions: string[] = [];
  let effectiveWeight = 0;
  let weightedScore = 0;

  const addSignal = (name: keyof typeof MATCHER_CONFIG.weights, score: number, sourceConfidence = 1) => {
    const reliability = clamp01(sourceConfidence);
    const weight = MATCHER_CONFIG.weights[name] * reliability;
    signals[name] = clamp01(score);
    availableSignals.push(name);
    effectiveWeight += weight;
    weightedScore += signals[name] * weight;
  };

  if (doc.totalAmount != null) {
    const currencyMismatch = Boolean(doc.currency && tx.currency && normalizeCurrency(doc.currency) !== normalizeCurrency(tx.currency));
    addSignal(
      'amount',
      currencyMismatch ? 0 : scoreAmount(doc.totalAmount, tx.amount, { allowTip: isTipEligible(doc, tx) }),
      doc.fieldConfidences?.totalAmount,
    );
    if (currencyMismatch && fieldConfidence(doc, 'currency') >= MATCHER_CONFIG.extraction.hardContradictionConfidence) {
      contradictions.push('currency_mismatch');
      signals.currency = 0;
    }
  }

  if (doc.documentDate) {
    const parsed = new Date(doc.documentDate);
    if (Number.isFinite(parsed.getTime())) {
      const reliability = doc.dateSource === 'RECEIVED_AT'
        ? Math.min(doc.fieldConfidences?.documentDate ?? 0.25, 0.25)
        : doc.fieldConfidences?.documentDate;
      if (doc.dateSource === 'RECEIVED_AT') signals.dateFallback = 1;
      addSignal('date', scoreDate(parsed, tx.transactionAt), reliability);
    }
  }

  if (doc.merchantName) {
    const aliasScore = Math.max(0, ...(tx.merchantAliases ?? []).map((alias) => scoreMerchant(doc.merchantName!, alias)));
    let merchantScore = Math.max(scoreMerchant(doc.merchantName, tx.merchantName), aliasScore);
    if (aliasScore > 0) signals.merchantAlias = aliasScore;
    const docDescriptor = parseMerchantDescriptor(doc.merchantName);
    const txDescriptor = parseMerchantDescriptor(`${tx.merchantName} ${tx.merchantCity ?? ''}`);
    if (docDescriptor.city && txDescriptor.city) {
      signals.merchantCity = docDescriptor.city === txDescriptor.city ? 1 : 0;
      merchantScore = 0.85 * merchantScore + 0.15 * signals.merchantCity;
    }
    if (docDescriptor.branch && txDescriptor.branch) {
      signals.merchantBranch = docDescriptor.branch === txDescriptor.branch ? 1 : 0;
      merchantScore = 0.9 * merchantScore + 0.1 * signals.merchantBranch;
    }
    addSignal('merchant', merchantScore, doc.fieldConfidences?.merchantName);
  }

  if (doc.cardLast4) {
    const matches = normalizeDigits(doc.cardLast4) === normalizeDigits(tx.cardLast4);
    addSignal('cardLast4', matches ? 1 : 0, doc.fieldConfidences?.cardLast4);
    if (!matches && fieldConfidence(doc, 'cardLast4') >= MATCHER_CONFIG.extraction.hardContradictionConfidence) {
      contradictions.push('card_last4_mismatch');
    }
  }

  scoreExactIdentifier('vatNumber', doc.vatNumber, tx.merchantVatNumber, doc, signals, contradictions);
  scoreExactIdentifier('invoiceNumber', doc.invoiceNumber, tx.invoiceNumber, doc, signals, contradictions);
  scoreExactIdentifier('authorizationCode', doc.authorizationCode, tx.authorizationCode, doc, signals, contradictions);

  let confidence = effectiveWeight > 0 ? weightedScore / effectiveWeight : 0;
  const exactStrongIdentifier = signals.vatNumber === 1 || signals.invoiceNumber === 1 || signals.authorizationCode === 1;
  if (exactStrongIdentifier && confidence >= 0.70) confidence = Math.max(confidence, 0.97);

  // Rare evidence is more discriminative. Keep the adjustment deliberately
  // small until its value is calibrated against reviewer-labelled outcomes.
  if ((signals.merchant ?? 0) >= 0.6 && tx.merchantFrequency) {
    signals.merchantRarity = round3(1 / Math.sqrt(Math.max(1, tx.merchantFrequency)));
    confidence += MATCHER_CONFIG.uniqueness.merchantBonus * signals.merchantRarity;
  }
  if ((signals.amount ?? 0) >= 0.8 && tx.amountFrequency) {
    signals.amountRarity = round3(1 / Math.sqrt(Math.max(1, tx.amountFrequency)));
    confidence += MATCHER_CONFIG.uniqueness.amountBonus * signals.amountRarity;
  }

  if (contradictions.length > 0) confidence *= 0.35 ** contradictions.length;

  // Missing evidence should not display as certainty. sqrt keeps three strong
  // independent signals eligible for automation while discounting sparse matches.
  const evidenceCoverage = round3(clamp01(effectiveWeight));
  const decisionConfidence = round3(clamp01(confidence * Math.sqrt(evidenceCoverage)));

  return {
    transactionId: tx.id,
    confidence: round3(clamp01(confidence)),
    decisionConfidence,
    signals: mapValues(signals, round3),
    evidenceCoverage,
    availableSignals,
    contradictions,
  };
}

export function scoreAmount(
  docAmount: number,
  txAmount: number,
  options: { allowTip?: boolean } = { allowTip: true },
): number {
  if (docAmount <= 0 || txAmount <= 0) return 0;
  const diff = Math.abs(docAmount - txAmount);
  const exactTolerance = Math.max(
    MATCHER_CONFIG.amount.absoluteToleranceHalalas,
    Math.round(txAmount * MATCHER_CONFIG.amount.relativeTolerance),
  );
  if (diff <= exactTolerance) return 1;

  if (docAmount < txAmount && options.allowTip !== false) {
    const ratio = diff / txAmount;
    if (ratio <= MATCHER_CONFIG.amount.tipMaxRatio) {
      return Math.max(0, 1 - (ratio / MATCHER_CONFIG.amount.tipMaxRatio) * 0.5);
    }
    return 0;
  }

  const ratio = diff / txAmount;
  return docAmount > txAmount && ratio <= 0.02 ? 0.9 : 0;
}

export function scoreDate(docDate: Date, txDate: Date): number {
  if (!Number.isFinite(docDate.getTime()) || !Number.isFinite(txDate.getTime())) return 0;
  if (calendarDate(docDate) === calendarDate(txDate)) return 1;
  const days = Math.abs(docDate.getTime() - txDate.getTime()) / 86_400_000;
  if (days <= 1) return 0.98;
  if (days <= MATCHER_CONFIG.date.nearDays) {
    return 0.98 - ((days - 1) / (MATCHER_CONFIG.date.nearDays - 1)) * 0.28;
  }
  if (days <= MATCHER_CONFIG.date.maxDays) {
    return 0.7 - ((days - MATCHER_CONFIG.date.nearDays) /
      (MATCHER_CONFIG.date.maxDays - MATCHER_CONFIG.date.nearDays)) * 0.5;
  }
  return 0;
}

export function scoreMerchant(docName: string, txName: string): number {
  const a = normalizeMerchant(docName);
  const b = normalizeMerchant(txName);
  if (!a || !b) return 0;
  const nativeScore = merchantSimilarity(a, b);
  const transliteratedScore = merchantSimilarity(transliterateArabic(a), transliterateArabic(b));
  return round3(Math.max(nativeScore, transliteratedScore));
}

const MERCHANT_NOISE_TOKENS = new Set([
  'ST', 'STR', 'STA', 'STATION', 'STATIONS', 'STORE', 'STORES',
  'BR', 'BRANCH', 'CO', 'LTD', 'LLC', 'INC', 'POS', 'PLC', 'THE', 'AND', 'OF', 'FOR',
  'RUH', 'JED', 'DMM', 'MED', 'MEC', 'AHD', 'KHR', 'TAI',
  'محطة', 'فرع', 'شركة', 'مؤسسة',
]);

export function normalizeMerchant(name: string): string {
  return name
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/ـ/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[^A-Z0-9\u0600-\u06FF\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !MERCHANT_NOISE_TOKENS.has(token))
    .join(' ')
    .trim();
}

export interface MerchantDescriptor { core: string; city: string | null; branch: string | null }

/** Keep location/branch evidence separate from the chain-level merchant name. */
export function parseMerchantDescriptor(name: string): MerchantDescriptor {
  const upper = name.toUpperCase().replace(/[^A-Z0-9\u0600-\u06FF\s]/g, ' ');
  const cityAliases: Array<[RegExp, string]> = [
    [/\b(?:RUH|RIYADH)\b|الرياض/, 'RIYADH'],
    [/\b(?:JED|JEDDAH)\b|جدة/, 'JEDDAH'],
    [/\b(?:DMM|DAMMAM)\b|الدمام/, 'DAMMAM'],
    [/\b(?:MED|MADINAH)\b|المدينة/, 'MADINAH'],
  ];
  const city = cityAliases.find(([pattern]) => pattern.test(upper))?.[1] ?? null;
  const explicitBranch = upper.match(/(?:\bBR(?:ANCH)?\b|فرع)\s*([0-9٠-٩]+)/)?.[1];
  const acquirerBranch = upper.match(/\b(?:ST|STORE|BR)\s+([0-9]+)\b/)?.[1];
  return {
    core: normalizeMerchant(name),
    city,
    branch: explicitBranch ? normalizeDigits(explicitBranch) : acquirerBranch ?? null,
  };
}

function scoreExactIdentifier(
  name: 'vatNumber' | 'invoiceNumber' | 'authorizationCode',
  docValue: string | null | undefined,
  txValue: string | null | undefined,
  doc: ExtractedFields,
  signals: Record<string, number>,
  contradictions: string[],
): void {
  if (!docValue || !txValue) return;
  const matches = normalizeIdentifier(docValue) === normalizeIdentifier(txValue);
  signals[name] = matches ? 1 : 0;
  if (!matches && fieldConfidence(doc, name) >= MATCHER_CONFIG.extraction.hardContradictionConfidence) {
    contradictions.push(`${name}_mismatch`);
  }
}

function fieldConfidence(doc: ExtractedFields, field: keyof FieldConfidences): number {
  return clamp01(doc.fieldConfidences?.[field] ?? 1);
}

function isTipEligible(doc: ExtractedFields, tx: CandidateTransaction): boolean {
  if (doc.documentType !== 'RECEIPT') return false;
  const category = `${tx.merchantCategory ?? ''} ${tx.merchantName}`.toUpperCase();
  return /RESTAURANT|\bREST\b|CAFE|COFFEE|HOTEL|HOSPITALITY|مطعم|مقهى/.test(category);
}

function calendarDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MATCHER_CONFIG.date.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function normalizeCurrency(currency: string): string { return currency.trim().toUpperCase(); }
function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/\D/g, '');
}
function normalizeIdentifier(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\u0600-\u06FF]/g, '');
}

function merchantSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 0.5 * jaccardTokens(a, b) + 0.5 * diceBigrams(a, b);
}

/** Lightweight cross-script fallback; aliases should replace this as labelled data grows. */
function transliterateArabic(input: string): string {
  const map: Record<string, string> = {
    ا: 'A', ب: 'B', ت: 'T', ث: 'TH', ج: 'J', ح: 'H', خ: 'KH', د: 'D', ذ: 'TH',
    ر: 'R', ز: 'Z', س: 'S', ش: 'SH', ص: 'S', ض: 'D', ط: 'T', ظ: 'Z', ع: 'A',
    غ: 'GH', ف: 'F', ق: 'Q', ك: 'K', ل: 'L', م: 'M', ن: 'N', ه: 'H', و: 'W',
    ي: 'Y', ة: 'H', ء: '',
  };
  return [...input].map((char) => map[char] ?? char).join('');
}

function jaccardTokens(a: string, b: string): number {
  const at = new Set(a.split(' '));
  const bt = new Set(b.split(' '));
  if (at.size === 0 || bt.size === 0) return 0;
  let intersection = 0;
  for (const token of at) if (bt.has(token)) intersection++;
  return intersection / (at.size + bt.size - intersection);
}

function diceBigrams(a: string, b: string): number {
  const bigrams = (value: string) => {
    const compact = value.replace(/\s+/g, '');
    return Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2));
  };
  const ab = bigrams(a);
  const bb = bigrams(b);
  if (ab.length === 0 || bb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const gram of ab) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of bb) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) { overlap++; counts.set(gram, count - 1); }
  }
  return (2 * overlap) / (ab.length + bb.length);
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function round3(value: number): number { return Math.round(value * 1000) / 1000; }
function mapValues(obj: Record<string, number>, fn: (value: number) => number): Record<string, number> {
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, fn(value)]));
}
