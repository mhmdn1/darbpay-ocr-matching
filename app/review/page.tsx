import prisma from '@/lib/prisma';
import Image from 'next/image';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format } from 'date-fns';
import { AlertCircle, ArrowUpRight, CheckCircle2, ChevronDown, CircleHelp, Clock3, FileSearch, Inbox, Mail, MessageCircle, ReceiptText, ShieldCheck, XCircle } from 'lucide-react';
import { DecisionButtons } from './decision-buttons';
import { MATCHER_CONFIG } from '@/lib/services/transaction-matcher';
import { CandidateExplanation } from './candidate-explanation';
import { explainDocumentStatus } from '@/lib/services/document-status-reason';
import { MatchStatus } from '@/lib/generated/prisma/enums';
import {
  loadReviewDecisionHistory,
  type ReviewDecisionHistoryRow,
} from '@/lib/services/review-history';
import {
  REJECTION_REASON_LABELS,
  type RejectionReason,
} from '@/lib/domain/review-reasons';

export const dynamic = 'force-dynamic';

interface CandidateRow {
  matchId: number;
  transactionId: number;
  merchantName: string;
  amount: number;
  currency: string;
  transactionAt: Date;
  cardLast4: string;
  merchantVatNumber: string | null;
  invoiceNumber: string | null;
  authorizationCode: string | null;
  confidence: number;
  decisionConfidence: number;
  signals: Record<string, number>;
  evidenceCoverage: number;
  contradictions: string[];
  rank: number | null;
  explanation: string | null;
  explanationProvider: string | null;
  matchStatus: string;
  decidedBy: string | null;
  decidedAt: Date | null;
}

interface DocRow {
  id: number;
  source: string;
  senderIdentifier: string;
  status: string;
  documentType: string | null;
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: Date | null;
  cardLast4: string | null;
  vatNumber: string | null;
  invoiceNumber: string | null;
  authorizationCode: string | null;
  extractionConfidence: number | null;
  receivedAt: Date;
  updatedAt: Date;
  errorMessage: string | null;
  reviewReason: string | null;
  statusReason: string | null;
  statusDetails: string | null;
  candidates: CandidateRow[];
}

function formatMoney(minor: number | null, currency: string | null): string {
  if (minor == null) return '—';
  return `${((minor / 100).toFixed(2))} ${currency ?? ''}`.trim();
}

async function loadDocuments(status: 'NEEDS_REVIEW' | 'MATCHED' | 'UNMATCHED' | 'FAILED'): Promise<DocRow[]> {
  const visibleMatchStatuses: MatchStatus[] = status === 'NEEDS_REVIEW'
    ? [MatchStatus.CANDIDATE]
    : status === 'MATCHED'
      ? [MatchStatus.CONFIRMED, MatchStatus.AUTO_CONFIRMED]
      : status === 'UNMATCHED'
        ? [MatchStatus.REJECTED]
        : [];
  const docs = await prisma.document.findMany({
    where: { status },
    orderBy: { receivedAt: 'desc' },
    include: {
      matches: {
        // Review cards need actionable candidates; history needs the final
        // confirmed/rejected relationship so it can explain the outcome.
        where: { status: { in: visibleMatchStatuses } },
        include: { transaction: true },
        orderBy: [{ decisionConfidence: 'desc' }, { rank: 'asc' }],
      },
    },
  });

  const rows = docs.map((d) => ({
    id: d.id,
    source: d.source,
    senderIdentifier: d.senderIdentifier,
    status: d.status,
    documentType: d.documentType,
    merchantName: d.merchantName,
    totalAmount: d.totalAmount,
    currency: d.currency,
    documentDate: d.documentDate,
    cardLast4: d.cardLast4,
    vatNumber: d.vatNumber,
    invoiceNumber: d.invoiceNumber,
    authorizationCode: d.authorizationCode,
    extractionConfidence: d.extractionConfidence,
    receivedAt: d.receivedAt,
    updatedAt: d.updatedAt,
    errorMessage: d.errorMessage,
    reviewReason: d.reviewReason,
    statusReason: d.statusReason,
    statusDetails: d.statusDetails,
    candidates: d.matches
      .filter((m) => status !== 'NEEDS_REVIEW' || m.decisionConfidence >= MATCHER_CONFIG.thresholds.candidateDisplay)
      .map((m) => ({
      matchId: m.id,
      transactionId: m.transactionId,
      merchantName: m.transaction.merchantName,
      amount: m.transaction.amount,
      currency: m.transaction.currency,
      transactionAt: m.transaction.transactionAt,
      cardLast4: m.transaction.cardLast4,
      merchantVatNumber: m.transaction.merchantVatNumber,
      invoiceNumber: m.transaction.invoiceNumber,
      authorizationCode: m.transaction.authorizationCode,
      confidence: m.confidence,
      decisionConfidence: m.decisionConfidence,
      signals: safeParseSignals(m.signals),
      evidenceCoverage: m.evidenceCoverage,
      contradictions: safeParseArray(m.contradictions),
      rank: m.rank,
      explanation: m.explanation,
      explanationProvider: m.explanationProvider,
      matchStatus: m.status,
      decidedBy: m.decidedBy,
      decidedAt: m.decidedAt,
      })),
  }));
  return status === 'NEEDS_REVIEW'
    ? rows.sort((a, b) => reviewPriority(b) - reviewPriority(a))
    : rows;
}

function safeParseSignals(s: string): Record<string, number> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function safeParseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function reviewPriority(document: DocRow): number {
  const top = document.candidates[0];
  if (!top) return 0;
  const second = document.candidates[1];
  const gap = second ? top.decisionConfidence - second.decisionConfidence : top.decisionConfidence;
  const thresholdUncertainty = 1 - Math.min(1, Math.abs(top.decisionConfidence - 0.82) / 0.27);
  const ambiguity = Math.max(0, 0.12 - gap) / 0.12;
  return thresholdUncertainty + ambiguity + top.contradictions.length * 0.25;
}

export default async function ReviewPage() {
  const [needsReview, matched, unmatched, failed, decisionHistory] = await Promise.all([
    loadDocuments('NEEDS_REVIEW'),
    loadDocuments('MATCHED'),
    loadDocuments('UNMATCHED'),
    loadDocuments('FAILED'),
    loadReviewDecisionHistory(),
  ]);

  const total = needsReview.length + matched.length + unmatched.length + failed.length;
  const matchedRate = total === 0 ? 0 : Math.round((matched.length / total) * 100);
  const reviewedDocumentIds = new Set(decisionHistory.map((event) => event.documentId));
  const lifecycleHistory = [...matched, ...unmatched, ...failed]
    .filter((document) => !reviewedDocumentIds.has(document.id))
    .map((document) => ({
      key: `document-${document.id}`,
      occurredAt: document.updatedAt,
      document,
    }));
  const historyRows = [
    ...decisionHistory.map((event) => ({
      key: `decision-${event.eventId}`,
      occurredAt: event.occurredAt,
      event,
    })),
    ...lifecycleHistory,
  ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  return (
    <div className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <header className="border-b border-slate-200/80 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <div className="flex items-center gap-4">
            <Image src="/darb-logo.png" alt="Darb" width={128} height={33} className="h-8 w-auto" priority />
            <div className="hidden h-7 w-px bg-slate-200 sm:block" />
            <span className="hidden text-sm font-medium text-slate-500 sm:block">Receipt intelligence</span>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700">
            <span className="size-2 rounded-full bg-emerald-500" />
            Pipeline healthy
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-8 px-5 py-8 sm:px-8 lg:py-10">
        <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#3157d5]">Finance operations</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Document review</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
              Validate uncertain receipt matches. Every recommendation includes its evidence and contradictions.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Clock3 className="size-4" />
            Updated {format(new Date(), 'MMM d, HH:mm')}
          </div>
        </section>

        <section aria-label="Document summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Needs review" value={needsReview.length} detail="Awaiting a decision" icon={<FileSearch />} tone="blue" />
          <MetricCard label="Matched" value={matched.length} detail={`${matchedRate}% of all documents`} icon={<CheckCircle2 />} tone="green" />
          <MetricCard label="Unmatched" value={unmatched.length} detail="No plausible transaction" icon={<Inbox />} tone="amber" />
          <MetricCard label="Failed" value={failed.length} detail="Extraction needs attention" icon={<AlertCircle />} tone="red" />
        </section>

        <section aria-labelledby="needs-review-heading" className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 id="needs-review-heading" className="text-xl font-semibold">Needs your attention</h2>
              <p className="mt-1 text-sm text-slate-500">Most uncertain and ambiguous decisions appear first.</p>
            </div>
            {needsReview.length > 0 && (
              <Badge className="bg-[#eaf0ff] text-[#3157d5] hover:bg-[#eaf0ff]">{needsReview.length} open</Badge>
            )}
          </div>
        {needsReview.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-5">
            {needsReview.map((doc) => <DocumentCard key={doc.id} doc={doc} />)}
          </div>
        )}
        </section>

        <section id="history" aria-labelledby="other-heading" className="scroll-mt-6 space-y-4 pb-10">
          <div>
            <h2 id="other-heading" className="text-xl font-semibold">Processing history</h2>
            <p className="mt-1 text-sm text-slate-500">Reviewer decisions appear immediately; automatic and terminal outcomes are included too.</p>
          </div>
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/40">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50/80 hover:bg-slate-50/80">
                <TableHead className="pl-5">Document</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Merchant</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead className="pr-5">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {historyRows.map((row) => 'event' in row ? (
                <TableRow key={row.key}>
                  <TableCell className="pl-5 font-medium">#{row.event.documentId}</TableCell>
                  <TableCell><StatusBadge status={row.event.action === 'CONFIRM' ? 'MATCHED' : 'REJECTED'} /></TableCell>
                  <TableCell><SourceLabel source={row.event.source} /></TableCell>
                  <TableCell>{row.event.documentMerchantName ?? '—'}</TableCell>
                  <TableCell className="font-medium">{formatMoney(row.event.documentTotalAmount, row.event.documentCurrency)}</TableCell>
                  <TableCell className="text-xs text-slate-500">{format(row.occurredAt, 'MMM d, yyyy · HH:mm')}</TableCell>
                  <TableCell className="whitespace-normal pr-5"><DecisionOutcomeDetails event={row.event} /></TableCell>
                </TableRow>
              ) : (
                <TableRow key={row.key}>
                  <TableCell className="pl-5 font-medium">#{row.document.id}</TableCell>
                  <TableCell><StatusBadge status={row.document.status} /></TableCell>
                  <TableCell><SourceLabel source={row.document.source} /></TableCell>
                  <TableCell>{row.document.merchantName ?? '—'}</TableCell>
                  <TableCell className="font-medium">{formatMoney(row.document.totalAmount, row.document.currency)}</TableCell>
                  <TableCell className="text-xs text-slate-500">{format(row.occurredAt, 'MMM d, yyyy · HH:mm')}</TableCell>
                  <TableCell className="whitespace-normal pr-5"><OutcomeDetails doc={row.document} /></TableCell>
                </TableRow>
              ))}
              {historyRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                    Nothing here yet — fire a webhook to ingest a document.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>
      </main>
    </div>
  );
}

function DecisionOutcomeDetails({ event }: { event: ReviewDecisionHistoryRow }) {
  const matched = event.action === 'CONFIRM';
  const reasonLabel = rejectionReasonLabel(event.reason);
  return (
    <details className="group min-w-[260px] max-w-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition-colors hover:border-[#b9c9ff] hover:bg-[#f7f9ff]">
        <span className="inline-flex items-center gap-2">
          {matched
            ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />
            : <XCircle className="size-3.5 shrink-0 text-rose-600" />}
          {matched ? 'Candidate matched' : 'Candidate rejected'}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600 shadow-sm">
        <p>{matched
          ? 'A reviewer confirmed this exact document-to-transaction relationship.'
          : `A reviewer rejected this candidate: ${reasonLabel}.`}</p>
        {event.transaction ? (
          <div className="rounded-md bg-[#f5f7ff] p-2 text-slate-700">
            <p className="font-semibold">Transaction #{event.transaction.id} · {event.transaction.merchantName}</p>
            <p>{formatMoney(event.transaction.amount, event.transaction.currency)} · card •••• {event.transaction.cardLast4}</p>
            {event.transaction.decisionConfidence != null && (
              <p>Decision confidence at review: {Math.round(event.transaction.decisionConfidence * 100)}%</p>
            )}
          </div>
        ) : (
          <p className="rounded-md bg-amber-50 p-2 text-amber-700">Transaction snapshot unavailable for this older event.</p>
        )}
        <p>Decision by: {event.decidedBy}</p>
        <p className="font-mono text-[10px] uppercase tracking-wide text-slate-400">
          Reason code: {event.reason} · matcher: {event.matcherVersion}
        </p>
      </div>
    </details>
  );
}

function rejectionReasonLabel(reason: string): string {
  return reason in REJECTION_REASON_LABELS
    ? REJECTION_REASON_LABELS[reason as RejectionReason]
    : reason.toLowerCase().replaceAll('_', ' ');
}

function OutcomeDetails({ doc }: { doc: DocRow }) {
  const explanation = explainDocumentStatus(doc);
  const relatedMatch = doc.candidates[0];
  return (
    <details className="group min-w-[260px] max-w-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition-colors hover:border-[#b9c9ff] hover:bg-[#f7f9ff]">
        <span className="inline-flex items-center gap-2">
          <CircleHelp className="size-3.5 shrink-0 text-[#3157d5]" />
          {explanation.title}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600 shadow-sm">
        <p>{explanation.description}</p>
        {relatedMatch && (
          <div className="rounded-md bg-[#f5f7ff] p-2 text-slate-700">
            <p className="font-semibold">Transaction #{relatedMatch.transactionId} · {relatedMatch.merchantName}</p>
            <p>{formatMoney(relatedMatch.amount, relatedMatch.currency)} · decision confidence {Math.round(relatedMatch.decisionConfidence * 100)}%</p>
            {relatedMatch.decidedBy && <p>Decision by: {relatedMatch.decidedBy}</p>}
          </div>
        )}
        {explanation.facts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {explanation.facts.map((fact) => (
              <span key={fact} className="rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-600">{fact}</span>
            ))}
          </div>
        )}
        <p className="font-mono text-[10px] uppercase tracking-wide text-slate-400">
          Reason code: {doc.statusReason ?? doc.reviewReason ?? 'NOT_RECORDED'}
        </p>
      </div>
    </details>
  );
}

function DocumentCard({ doc }: { doc: DocRow }) {
  const topDecisionConfidence = doc.candidates[0]?.decisionConfidence ?? 0;
  const hasTopTie = doc.candidates.length > 1 && doc.candidates[1].decisionConfidence === topDecisionConfidence;
  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/50">
      <header className="flex flex-col justify-between gap-5 border-b border-slate-100 p-5 sm:flex-row sm:items-start lg:p-6">
        <div className="flex min-w-0 gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#eef3ff] text-[#3157d5]">
            <ReceiptText className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#3157d5]">
              Receipt / invoice being reviewed
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-lg font-semibold">{doc.merchantName ?? 'Unknown merchant'}</h3>
              <Badge className={doc.reviewReason === 'AUTO_MATCH_AUDIT'
                ? 'bg-violet-50 text-violet-700 hover:bg-violet-50'
                : 'bg-amber-50 text-amber-700 hover:bg-amber-50'}>
                {doc.reviewReason === 'AUTO_MATCH_AUDIT' ? 'Quality audit' : 'Review needed'}
              </Badge>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
              <SourceLabel source={doc.source} />
              <span>Document #{doc.id}</span>
              {doc.invoiceNumber && <span>Invoice {doc.invoiceNumber}</span>}
              {doc.documentDate && <span>{format(doc.documentDate, 'MMM d, yyyy')}</span>}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 sm:text-right">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Receipt total</p>
            <p className="mt-1 text-xl font-semibold">{formatMoney(doc.totalAmount, doc.currency)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Similarity</p>
            <p className="mt-1 text-xl font-semibold">{Math.round((doc.candidates[0]?.confidence ?? 0) * 100)}%</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Decision confidence</p>
            <p className="mt-1 text-xl font-semibold text-[#3157d5]">{Math.round(topDecisionConfidence * 100)}%</p>
          </div>
        </div>
      </header>

      <div className="space-y-3 p-4 sm:p-5 lg:p-6">
        <div className="flex items-center justify-between px-1">
          <div>
            <p className="text-sm font-semibold">Candidate transaction comparisons</p>
            <p className="mt-0.5 text-xs text-slate-400">Each transaction is compared directly with the extracted receipt above.</p>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-500" aria-label="Comparison signal legend">
              <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-500" />Strong agreement</span>
              <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-amber-500" />Partial agreement</span>
              <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-rose-500" />Conflict</span>
            </div>
          </div>
          <p className="text-xs text-slate-400">
            {doc.candidates.length} {doc.candidates.length === 1 ? 'candidate' : 'candidates'} ranked
          </p>
        </div>
        {doc.candidates.map((c, index) => {
          const tiedForTop = hasTopTie && c.decisionConfidence === topDecisionConfidence;
          const uniquelyRecommended = index === 0 && !hasTopTie;
          const highlighted = tiedForTop || uniquelyRecommended;
          return (
          <div key={c.matchId} className={`rounded-xl border p-4 transition-colors ${highlighted ? 'border-[#b9c9ff] bg-[#f7f9ff]' : 'border-slate-200 hover:border-slate-300'}`}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {tiedForTop && <Badge className="bg-violet-600 text-white hover:bg-violet-600">Tied for best</Badge>}
                  {uniquelyRecommended && <Badge className="bg-[#3157d5] text-white hover:bg-[#3157d5]">Recommended</Badge>}
                  <span className="font-semibold">{c.merchantName}</span>
                  <Badge variant="outline" className="bg-white text-xs font-medium text-slate-500">
                    Comparing with transaction #{c.transactionId}
                  </Badge>
                </div>
                <CandidateComparison doc={doc} candidate={c} />
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(c.signals).map(([name, score]) => (
                    <span key={name} className="rounded-md bg-white px-2 py-1 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
                      {signalLabel(name)} <strong className="ml-1 text-slate-800">{Math.round(score * 100)}%</strong>
                    </span>
                  ))}
                  <span className="rounded-md bg-white px-2 py-1 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
                    Evidence <strong className="ml-1 text-slate-800">{Math.round(c.evidenceCoverage * 100)}%</strong>
                  </span>
                  {c.contradictions.map((contradiction) => (
                    <span key={contradiction} className="rounded-md bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200">
                      {contradiction.replaceAll('_', ' ')}
                    </span>
                  ))}
                </div>
                <CandidateExplanation
                  matchId={c.matchId}
                  initialExplanation={c.explanation}
                  initialProvider={c.explanationProvider}
                />
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-slate-200/70 pt-4 lg:w-[380px] lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
                <div className="grid min-w-[190px] grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Similarity</p>
                    <p className="mt-1 text-lg font-semibold">{Math.round(c.confidence * 100)}%</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Evidence</p>
                    <p className="mt-1 text-lg font-semibold">{Math.round(c.evidenceCoverage * 100)}%</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-[#3157d5]">Decision</p>
                    <p className="mt-1 text-lg font-semibold text-[#3157d5]">{Math.round(c.decisionConfidence * 100)}%</p>
                  </div>
                  <div className="col-span-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-[#3157d5]" style={{ width: `${Math.round(c.decisionConfidence * 100)}%` }} />
                  </div>
                  <p className="col-span-3 text-[10px] leading-4 text-slate-400">Decision confidence discounts missing evidence.</p>
                </div>
                <DecisionButtons matchId={c.matchId} />
              </div>
            </div>
          </div>
          );
        })}
      </div>
    </article>
  );
}

interface ComparisonField {
  label: string;
  receiptValue: string;
  transactionValue: string;
  signal?: number;
}

function CandidateComparison({ doc, candidate }: { doc: DocRow; candidate: CandidateRow }) {
  const fields: ComparisonField[] = [
    {
      label: 'Merchant',
      receiptValue: doc.merchantName ?? 'Not extracted',
      transactionValue: candidate.merchantName,
      signal: candidate.signals.merchant,
    },
    {
      label: 'Amount',
      receiptValue: formatMoney(doc.totalAmount, doc.currency),
      transactionValue: formatMoney(candidate.amount, candidate.currency),
      signal: candidate.signals.amount,
    },
    {
      label: 'Date',
      receiptValue: doc.documentDate ? format(doc.documentDate, 'MMM d, yyyy') : 'Not extracted',
      transactionValue: format(candidate.transactionAt, 'MMM d, yyyy · HH:mm'),
      signal: candidate.signals.date ?? candidate.signals.dateFallback,
    },
    {
      label: 'Card',
      receiptValue: doc.cardLast4 ? `•••• ${doc.cardLast4}` : 'Not extracted',
      transactionValue: `•••• ${candidate.cardLast4}`,
      signal: candidate.signals.cardLast4,
    },
  ];

  appendOptionalComparison(fields, 'Invoice', doc.invoiceNumber, candidate.invoiceNumber, candidate.signals.invoiceNumber);
  appendOptionalComparison(fields, 'VAT number', doc.vatNumber, candidate.merchantVatNumber, candidate.signals.vatNumber);
  appendOptionalComparison(
    fields,
    'Authorization',
    doc.authorizationCode,
    candidate.authorizationCode,
    candidate.signals.authorizationCode,
  );

  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <div className="min-w-[620px]">
        <div className="grid grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)] border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <div className="px-3 py-2">Compared field</div>
          <div className="border-l border-slate-200 px-3 py-2 text-[#3157d5]">Extracted receipt / invoice</div>
          <div className="border-l border-slate-200 px-3 py-2 text-slate-700">Transaction #{candidate.transactionId}</div>
        </div>
        {fields.map((field) => (
          <div
            key={field.label}
            className="grid grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)] border-b border-slate-100 text-xs last:border-b-0"
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 font-medium text-slate-500">
              <span>{field.label}</span>
              <SignalIndicator score={field.signal} />
            </div>
            <div className="border-l border-slate-100 px-3 py-2.5 font-medium text-slate-800">{field.receiptValue}</div>
            <div className="border-l border-slate-100 px-3 py-2.5 font-medium text-slate-800">{field.transactionValue}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function appendOptionalComparison(
  fields: ComparisonField[],
  label: string,
  receiptValue: string | null,
  transactionValue: string | null,
  signal?: number,
) {
  if (!receiptValue && !transactionValue) return;
  fields.push({
    label,
    receiptValue: receiptValue ?? 'Not extracted',
    transactionValue: transactionValue ?? 'Not available',
    signal,
  });
}

function SignalIndicator({ score }: { score?: number }) {
  if (score == null) return null;
  if (score >= 0.9) {
    return <span title="Strong agreement" aria-label="Strong agreement" className="size-2 shrink-0 rounded-full bg-emerald-500" />;
  }
  if (score <= 0.05) {
    return <span title="Conflicting values" aria-label="Conflicting values" className="size-2 shrink-0 rounded-full bg-rose-500" />;
  }
  return <span title="Partial agreement" aria-label="Partial agreement" className="size-2 shrink-0 rounded-full bg-amber-500" />;
}

function signalLabel(signal: string): string {
  const labels: Record<string, string> = {
    cardLast4: 'Card', merchantRarity: 'Merchant rarity', amountRarity: 'Amount rarity',
    merchantAlias: 'Learned alias',
    merchantCity: 'City', merchantBranch: 'Branch', dateFallback: 'Received date',
    vatNumber: 'VAT number', invoiceNumber: 'Invoice number', authorizationCode: 'Authorization',
  };
  return labels[signal] ?? signal.charAt(0).toUpperCase() + signal.slice(1);
}

function StatusBadge({ status }: { status: string }) {
  const variant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    MATCHED: 'default',
    NEEDS_REVIEW: 'secondary',
    UNMATCHED: 'outline',
    FAILED: 'destructive',
    EXTRACTED: 'outline',
    RECEIVED: 'outline',
  };
  return <Badge variant={variant[status] ?? 'outline'} className="capitalize">{status.toLowerCase().replace('_', ' ')}</Badge>;
}

function SourceLabel({ source }: { source: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-500">
      {source === 'EMAIL' ? <Mail className="size-3.5" /> : <MessageCircle className="size-3.5" />}
      {source === 'EMAIL' ? 'Email' : 'WhatsApp'}
    </span>
  );
}

function MetricCard({ label, value, detail, icon, tone }: { label: string; value: number; detail: string; icon: React.ReactNode; tone: 'blue' | 'green' | 'amber' | 'red' }) {
  const tones = {
    blue: 'bg-[#eef3ff] text-[#3157d5]', green: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600', red: 'bg-rose-50 text-rose-600',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/40">
      <div className="flex items-start justify-between">
        <div><p className="text-sm font-medium text-slate-500">{label}</p><p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p></div>
        <div className={`flex size-10 items-center justify-center rounded-xl [&_svg]:size-5 ${tones[tone]}`}>{icon}</div>
      </div>
      <p className="mt-3 text-xs text-slate-400">{detail}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><ShieldCheck className="size-6" /></div>
      <h3 className="mt-4 font-semibold">You’re all caught up</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">There are no uncertain matches waiting for a finance review.</p>
      <a href="#history" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-[#3157d5]">View processing history <ArrowUpRight className="size-4" /></a>
    </div>
  );
}
