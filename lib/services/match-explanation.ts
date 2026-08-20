import { createHash } from 'node:crypto';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import type { Prisma } from '@/lib/generated/prisma/client';
import { log } from '@/lib/logger';
import { MATCHER_CONFIG } from '@/lib/services/transaction-matcher';

export const EXPLANATION_PROMPT_VERSION = 'match-explanation-v1';

const CORE_SIGNALS = ['amount', 'date', 'merchant', 'cardLast4'] as const;

export type ReviewTrigger =
  | 'TRANSACTION_ALREADY_CONFIRMED'
  | 'TOP_CANDIDATES_TOO_CLOSE'
  | 'RECEIVED_DATE_FALLBACK'
  | 'LOW_EVIDENCE'
  | 'TOO_FEW_SIGNALS'
  | 'CONTRADICTION'
  | 'BELOW_AUTO_THRESHOLD'
  | 'LOWER_RANKED'
  | 'AUDIT_SAMPLE';

export interface ExplanationSignal {
  name: string;
  score: number;
}

/**
 * Deliberately contains no raw OCR text, sender identity, card digits, merchant
 * name, or transaction identifier. The model only explains matcher evidence.
 */
export interface MatchExplanationInput {
  confidence: number;
  rank: number;
  candidateCount: number;
  topScoreGap: number | null;
  evidenceCoverage: number;
  signals: ExplanationSignal[];
  contradictions: string[];
  reviewTriggers: ReviewTrigger[];
}

export interface GeneratedExplanation {
  text: string;
  provider: 'openai' | 'local';
  model: string;
}

export interface MatchExplanationGenerator {
  generate(input: MatchExplanationInput): Promise<GeneratedExplanation>;
}

export interface ExplainMatchResult extends GeneratedExplanation {
  matchId: number;
  cached: boolean;
  generatedAt: string;
}

const generatedTextSchema = z.string().trim().min(20).max(360);

const openAIResponseSchema = z.object({
  output_text: z.string().optional(),
  output: z.array(z.object({
    content: z.array(z.object({ text: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

export class LocalMatchExplanationGenerator implements MatchExplanationGenerator {
  async generate(input: MatchExplanationInput): Promise<GeneratedExplanation> {
    return {
      text: generateLocalExplanation(input),
      provider: 'local',
      model: 'deterministic-v1',
    };
  }
}

export class OpenAIMatchExplanationGenerator implements MatchExplanationGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.OPENAI_EXPLANATION_MODEL?.trim() || 'gpt-5.4',
  ) {}

  async generate(input: MatchExplanationInput): Promise<GeneratedExplanation> {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        max_output_tokens: 120,
        instructions:
          'Write one or two short plain-language sentences for a finance reviewer. ' +
          'Explain the strongest matching evidence and exactly why human review is still needed. ' +
          'Do not make a decision, invent facts, call the score a probability, or mention internal trigger names. ' +
          'Stay under 45 words.',
        input: JSON.stringify(input),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Explanation provider returned HTTP ${response.status}`);
    }

    const parsed = openAIResponseSchema.parse(await response.json());
    const text = parsed.output_text ?? parsed.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text)
      .find((value): value is string => Boolean(value));

    return {
      text: normalizeGeneratedText(text),
      provider: 'openai',
      model: this.model,
    };
  }
}

export function createMatchExplanationGenerator(): MatchExplanationGenerator {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? new OpenAIMatchExplanationGenerator(key) : new LocalMatchExplanationGenerator();
}

/** Generate or return a stored explanation. This function is called only by the explicit UI action. */
export async function explainMatchOnDemand(
  matchId: number,
  generator: MatchExplanationGenerator = createMatchExplanationGenerator(),
): Promise<ExplainMatchResult> {
  const match = await prisma.documentMatch.findUnique({
    where: { id: matchId },
    include: {
      document: {
        include: {
          matches: {
            where: { status: 'CANDIDATE' },
            orderBy: [{ confidence: 'desc' }, { rank: 'asc' }, { id: 'asc' }],
          },
        },
      },
      transaction: {
        include: {
          documents: {
            where: { status: { in: ['CONFIRMED', 'AUTO_CONFIRMED'] } },
            select: { id: true },
          },
        },
      },
    },
  });

  if (!match) throw new Error('Match not found');
  if (match.status !== 'CANDIDATE' || match.document.status !== 'NEEDS_REVIEW') {
    throw new Error('Only pending review candidates can be explained');
  }

  const input = buildExplanationInput(match);
  const inputHash = hashExplanationInput(input);

  if (
    match.explanation &&
    match.explanationInputHash === inputHash &&
    match.explanationPromptVersion === EXPLANATION_PROMPT_VERSION &&
    match.explanationGeneratedAt
  ) {
    return {
      matchId,
      text: match.explanation,
      provider: match.explanationProvider === 'openai' ? 'openai' : 'local',
      model: match.explanationModel ?? 'unknown',
      cached: true,
      generatedAt: match.explanationGeneratedAt.toISOString(),
    };
  }

  let generated: GeneratedExplanation;
  try {
    generated = await generator.generate(input);
  } catch (error) {
    log.warn('match explanation provider failed; using local explanation', {
      matchId,
      message: error instanceof Error ? error.message : String(error),
    });
    generated = await new LocalMatchExplanationGenerator().generate(input);
  }
  generated = { ...generated, text: normalizeGeneratedText(generated.text) };

  const now = new Date();
  const updated = await prisma.documentMatch.updateMany({
    where: { id: matchId, status: 'CANDIDATE' },
    data: {
      explanation: generated.text,
      explanationInputHash: inputHash,
      explanationProvider: generated.provider,
      explanationModel: generated.model,
      explanationPromptVersion: EXPLANATION_PROMPT_VERSION,
      explanationGeneratedAt: now,
    },
  });
  if (updated.count === 0) throw new Error('Match state changed; refresh and try again');

  log.info('match explanation generated on demand', { matchId, provider: generated.provider });
  return { matchId, ...generated, cached: false, generatedAt: now.toISOString() };
}

type LoadedMatch = Prisma.DocumentMatchGetPayload<{
  include: {
    document: { include: { matches: true } };
    transaction: { include: { documents: { select: { id: true } } } };
  };
}>;

function buildExplanationInput(match: LoadedMatch): MatchExplanationInput {
  const siblings = [...match.document.matches]
    .filter((candidate) => candidate.status === 'CANDIDATE')
    .sort((a, b) => b.confidence - a.confidence || (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.id - b.id);
  const position = siblings.findIndex((candidate) => candidate.id === match.id);
  const topGap = siblings.length > 1 ? siblings[0].confidence - siblings[1].confidence : null;
  const signals = parseSignals(match.signals);
  const contradictions = parseStringArray(match.contradictions);
  const availableCoreSignals = CORE_SIGNALS.filter((name) => name in signals).length;
  const triggers: ReviewTrigger[] = [];

  if (match.transaction.documents.length > 0) triggers.push('TRANSACTION_ALREADY_CONFIRMED');
  const tiedForTop = position >= 0 && siblings[0]?.confidence === match.confidence;
  if (tiedForTop && topGap != null && topGap < MATCHER_CONFIG.thresholds.autoMatchGap) triggers.push('TOP_CANDIDATES_TOO_CLOSE');
  if (!match.document.documentDate || signals.dateFallback === 1) triggers.push('RECEIVED_DATE_FALLBACK');
  if (match.evidenceCoverage < MATCHER_CONFIG.thresholds.minAutoEvidenceCoverage) triggers.push('LOW_EVIDENCE');
  if (availableCoreSignals < MATCHER_CONFIG.thresholds.minAutoSignals) triggers.push('TOO_FEW_SIGNALS');
  if (contradictions.length > 0) triggers.push('CONTRADICTION');
  if (match.confidence < MATCHER_CONFIG.thresholds.autoMatch) triggers.push('BELOW_AUTO_THRESHOLD');
  if (position > 0) triggers.push('LOWER_RANKED');
  if (match.document.reviewReason === 'AUTO_MATCH_AUDIT') triggers.push('AUDIT_SAMPLE');

  return {
    confidence: round3(match.confidence),
    rank: position >= 0 ? position + 1 : match.rank ?? 1,
    candidateCount: siblings.length,
    topScoreGap: topGap == null ? null : round3(topGap),
    evidenceCoverage: round3(match.evidenceCoverage),
    signals: Object.entries(signals)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, score]) => ({ name, score: round3(score) })),
    contradictions: [...contradictions].sort(),
    reviewTriggers: triggers,
  };
}

export function generateLocalExplanation(input: MatchExplanationInput): string {
  const agreements = input.signals.filter((signal) => signal.score >= 0.8 && signal.name !== 'dateFallback');
  const disagreements = input.signals.filter((signal) => signal.score <= 0.2 && signal.name !== 'dateFallback');
  const evidence = agreements.length > 0
    ? `${formatList(agreements.slice(0, 4).map((signal) => signalLabel(signal.name)))} ${agreements.length === 1 ? 'supports' : 'support'} this candidate`
    : `This candidate has a ${Math.round(input.confidence * 100)}% heuristic score`;

  if (input.reviewTriggers.includes('TRANSACTION_ALREADY_CONFIRMED')) {
    return `${capitalize(evidence)}. Review is required because this transaction already has a confirmed document.`;
  }
  if (input.reviewTriggers.includes('TOP_CANDIDATES_TOO_CLOSE')) {
    return `${capitalize(evidence)}, but another candidate has nearly the same score. Check the receipt details before choosing.`;
  }
  if (input.reviewTriggers.includes('RECEIVED_DATE_FALLBACK')) {
    return `${capitalize(evidence)}. Review is required because the receipt has no reliable printed date, so its received date was used.`;
  }
  if (input.reviewTriggers.includes('CONTRADICTION')) {
    return `${capitalize(evidence)}, but ${formatList(input.contradictions.map(contradictionLabel))} ${input.contradictions.length === 1 ? 'conflicts' : 'conflict'} with the receipt.`;
  }
  if (input.reviewTriggers.includes('LOWER_RANKED')) {
    const mismatch = disagreements.length > 0
      ? `; ${formatList(disagreements.slice(0, 3).map((signal) => signalLabel(signal.name)))} do not align`
      : '';
    return `This is candidate ${input.rank} of ${input.candidateCount} with a ${Math.round(input.confidence * 100)}% heuristic score${mismatch}. Compare it with the higher-ranked option before matching.`;
  }
  if (input.reviewTriggers.includes('LOW_EVIDENCE') || input.reviewTriggers.includes('TOO_FEW_SIGNALS')) {
    return `${capitalize(evidence)}, but only ${Math.round(input.evidenceCoverage * 100)}% of the expected evidence is available. More receipt detail is needed before matching.`;
  }
  if (input.reviewTriggers.includes('BELOW_AUTO_THRESHOLD')) {
    return `${capitalize(evidence)}, but the ${Math.round(input.confidence * 100)}% heuristic score is below the automatic-match threshold. A reviewer must confirm or reject it.`;
  }
  if (input.reviewTriggers.includes('AUDIT_SAMPLE')) {
    return `${capitalize(evidence)}. This strong candidate was intentionally sampled for a human quality audit.`;
  }
  return `${capitalize(evidence)}. A reviewer should verify the receipt before making the final decision.`;
}

function hashExplanationInput(input: MatchExplanationInput): string {
  return createHash('sha256')
    .update(`${EXPLANATION_PROMPT_VERSION}:${JSON.stringify(input)}`)
    .digest('hex');
}

function normalizeGeneratedText(value: string | undefined): string {
  const normalized = value?.replace(/\s+/g, ' ').replace(/^['"]|['"]$/g, '').trim();
  return generatedTextSchema.parse(normalized);
}

function parseSignals(value: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return {};
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function signalLabel(value: string): string {
  const labels: Record<string, string> = {
    amount: 'amount', date: 'date', merchant: 'merchant', cardLast4: 'card',
    vatNumber: 'VAT number', invoiceNumber: 'invoice number', authorizationCode: 'authorization code',
    merchantCity: 'city', merchantBranch: 'branch',
  };
  return labels[value] ?? value.replaceAll('_', ' ');
}

function contradictionLabel(value: string): string {
  const labels: Record<string, string> = {
    currency_mismatch: 'the currency', card_last4_mismatch: 'the card digits',
    vatNumber_mismatch: 'the VAT number', invoiceNumber_mismatch: 'the invoice number',
    authorizationCode_mismatch: 'the authorization code',
  };
  return labels[value] ?? value.replaceAll('_', ' ');
}

function formatList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? 'limited evidence';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
