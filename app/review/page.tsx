import prisma from '@/lib/prisma';
import Image from 'next/image';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format } from 'date-fns';
import { AlertCircle, ArrowUpRight, CheckCircle2, Clock3, FileSearch, Inbox, Mail, MessageCircle, ReceiptText, ShieldCheck } from 'lucide-react';
import { DecisionButtons } from './decision-buttons';
import { MATCHER_CONFIG } from '@/lib/services/transaction-matcher';

export const dynamic = 'force-dynamic';

interface CandidateRow {
  matchId: number;
  transactionId: number;
  merchantName: string;
  amount: number;
  currency: string;
  transactionAt: Date;
  cardLast4: string;
  confidence: number;
  signals: Record<string, number>;
  evidenceCoverage: number;
  contradictions: string[];
  rank: number | null;
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
  invoiceNumber: string | null;
  extractionConfidence: number | null;
  receivedAt: Date;
  errorMessage: string | null;
  reviewReason: string | null;
  candidates: CandidateRow[];
}

function formatMoney(minor: number | null, currency: string | null): string {
  if (minor == null) return '—';
  return `${((minor / 100).toFixed(2))} ${currency ?? ''}`.trim();
}

async function loadDocuments(status: 'NEEDS_REVIEW' | 'MATCHED' | 'UNMATCHED' | 'FAILED'): Promise<DocRow[]> {
  const docs = await prisma.document.findMany({
    where: { status },
    orderBy: { receivedAt: 'desc' },
    include: {
      matches: {
        // Only undecided rows are actionable. Keeping REJECTED siblings in
        // this list leaves stale Match/Reject buttons after revalidation.
        where: { status: 'CANDIDATE' },
        include: { transaction: true },
        orderBy: { confidence: 'desc' },
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
    invoiceNumber: d.invoiceNumber,
    extractionConfidence: d.extractionConfidence,
    receivedAt: d.receivedAt,
    errorMessage: d.errorMessage,
    reviewReason: d.reviewReason,
    candidates: d.matches
      .filter((m) => m.confidence >= MATCHER_CONFIG.thresholds.candidateDisplay)
      .map((m) => ({
      matchId: m.id,
      transactionId: m.transactionId,
      merchantName: m.transaction.merchantName,
      amount: m.transaction.amount,
      currency: m.transaction.currency,
      transactionAt: m.transaction.transactionAt,
      cardLast4: m.transaction.cardLast4,
      confidence: m.confidence,
      signals: safeParseSignals(m.signals),
      evidenceCoverage: m.evidenceCoverage,
      contradictions: safeParseArray(m.contradictions),
      rank: m.rank,
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
  const gap = second ? top.confidence - second.confidence : top.confidence;
  const thresholdUncertainty = 1 - Math.min(1, Math.abs(top.confidence - 0.82) / 0.27);
  const ambiguity = Math.max(0, 0.12 - gap) / 0.12;
  return thresholdUncertainty + ambiguity + top.contradictions.length * 0.25;
}

export default async function ReviewPage() {
  const [needsReview, matched, unmatched, failed] = await Promise.all([
    loadDocuments('NEEDS_REVIEW'),
    loadDocuments('MATCHED'),
    loadDocuments('UNMATCHED'),
    loadDocuments('FAILED'),
  ]);

  const total = needsReview.length + matched.length + unmatched.length + failed.length;
  const matchedRate = total === 0 ? 0 : Math.round((matched.length / total) * 100);

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
            <p className="mt-1 text-sm text-slate-500">Recently processed documents across every terminal state.</p>
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
                <TableHead>Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...matched, ...unmatched, ...failed].map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="pl-5 font-medium">#{d.id}</TableCell>
                  <TableCell><StatusBadge status={d.status} /></TableCell>
                  <TableCell><SourceLabel source={d.source} /></TableCell>
                  <TableCell>{d.merchantName ?? '—'}</TableCell>
                  <TableCell className="font-medium">{formatMoney(d.totalAmount, d.currency)}</TableCell>
                  <TableCell className="text-xs text-slate-500">{format(d.receivedAt, 'MMM d, yyyy · HH:mm')}</TableCell>
                </TableRow>
              ))}
              {matched.length + unmatched.length + failed.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-slate-500">
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

function DocumentCard({ doc }: { doc: DocRow }) {
  const topConfidence = doc.candidates[0]?.confidence ?? 0;
  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/50">
      <header className="flex flex-col justify-between gap-5 border-b border-slate-100 p-5 sm:flex-row sm:items-start lg:p-6">
        <div className="flex min-w-0 gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#eef3ff] text-[#3157d5]">
            <ReceiptText className="size-5" />
          </div>
          <div className="min-w-0">
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
        <div className="grid grid-cols-2 gap-5 sm:text-right">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Receipt total</p>
            <p className="mt-1 text-xl font-semibold">{formatMoney(doc.totalAmount, doc.currency)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Match score</p>
            <p className="mt-1 text-xl font-semibold text-[#3157d5]">{Math.round(topConfidence * 100)}%</p>
          </div>
        </div>
      </header>

      <div className="space-y-3 p-4 sm:p-5 lg:p-6">
        <div className="flex items-center justify-between px-1">
          <p className="text-sm font-semibold">Candidate transactions</p>
          <p className="text-xs text-slate-400">{doc.candidates.length} candidates ranked</p>
        </div>
        {doc.candidates.map((c, index) => (
          <div key={c.matchId} className={`rounded-xl border p-4 transition-colors ${index === 0 ? 'border-[#b9c9ff] bg-[#f7f9ff]' : 'border-slate-200 hover:border-slate-300'}`}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {index === 0 && <Badge className="bg-[#3157d5] text-white hover:bg-[#3157d5]">Recommended</Badge>}
                  <span className="font-semibold">{c.merchantName}</span>
                  <span className="text-xs text-slate-400">Transaction #{c.transactionId}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-500">
                  <span className="font-medium text-slate-800">{formatMoney(c.amount, c.currency)}</span>
                  <span>{format(c.transactionAt, 'MMM d, yyyy · HH:mm')}</span>
                  <span>Card •••• {c.cardLast4}</span>
                </div>
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
              </div>
              <div className="flex items-center justify-between gap-5 border-t border-slate-200/70 pt-4 lg:w-[270px] lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
                <div className="min-w-[72px]">
                  <p className="text-2xl font-semibold tracking-tight">{Math.round(c.confidence * 100)}%</p>
                  <div className="mt-1 h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-[#3157d5]" style={{ width: `${Math.round(c.confidence * 100)}%` }} />
                  </div>
                </div>
                <DecisionButtons matchId={c.matchId} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function signalLabel(signal: string): string {
  const labels: Record<string, string> = {
    cardLast4: 'Card', merchantRarity: 'Merchant rarity', amountRarity: 'Amount rarity',
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
