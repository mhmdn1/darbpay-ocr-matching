'use client';

import { useTransition, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Check, LoaderCircle, X } from 'lucide-react';
import { confirmMatch, rejectMatch } from '@/lib/actions/review';
import {
  REJECTION_REASONS,
  REJECTION_REASON_LABELS,
  type RejectionReason,
} from '@/lib/domain/review-reasons';

export function DecisionButtons({ matchId }: { matchId: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showRejectReason, setShowRejectReason] = useState(false);
  const [rejectReason, setRejectReason] = useState<RejectionReason>('NOT_SAME_PURCHASE');

  const runConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await confirmMatch({ matchId });
      if (result?.serverError) {
        setError(String(result.serverError));
        return;
      }
      router.refresh();
    });
  };

  const runReject = () => {
    setError(null);
    startTransition(async () => {
      const result = await rejectMatch({ matchId, reason: rejectReason });
      if (result?.serverError) {
        setError(String(result.serverError));
        return;
      }
      setShowRejectReason(false);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {showRejectReason ? (
        <div className="flex max-w-[250px] flex-wrap justify-end gap-2 rounded-lg border border-rose-100 bg-rose-50/60 p-2">
          <label className="basis-full text-left text-[11px] font-semibold text-slate-600" htmlFor={`reject-reason-${matchId}`}>
            Why is this candidate wrong?
          </label>
          <select
            id={`reject-reason-${matchId}`}
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value as RejectionReason)}
            disabled={pending}
            className="h-8 basis-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700"
          >
            {REJECTION_REASONS.map((reason) => (
              <option key={reason} value={reason}>{REJECTION_REASON_LABELS[reason]}</option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={() => setShowRejectReason(false)} disabled={pending} className="h-8 px-2 text-xs">
            Cancel
          </Button>
          <Button size="sm" onClick={runReject} disabled={pending} className="h-8 bg-rose-600 px-2 text-xs text-white hover:bg-rose-700">
            {pending ? <LoaderCircle className="animate-spin" /> : <X />}
            Confirm reject
          </Button>
        </div>
      ) : (
        <>
          <Button
            size="sm"
            onClick={runConfirm}
            disabled={pending}
            className="bg-[#3157d5] px-3 text-white hover:bg-[#294bc0]"
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Check />}
            Match
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowRejectReason(true)} disabled={pending} className="px-3 text-slate-600">
            <X />
            Reject
          </Button>
        </>
      )}
      {error && <span role="alert" className="basis-full text-right text-xs text-destructive">{error}</span>}
    </div>
  );
}
