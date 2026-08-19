'use client';

import { useTransition, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Check, LoaderCircle, X } from 'lucide-react';
import { confirmMatch, rejectMatch } from '@/lib/actions/review';

export function DecisionButtons({ matchId }: { matchId: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: typeof confirmMatch) => () => {
    setError(null);
    startTransition(async () => {
      const result = await fn({ matchId });
      if (result?.serverError) setError(String(result.serverError));
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        size="sm"
        onClick={run(confirmMatch)}
        disabled={pending}
        className="bg-[#3157d5] px-3 text-white hover:bg-[#294bc0]"
      >
        {pending ? <LoaderCircle className="animate-spin" /> : <Check />}
        Match
      </Button>
      <Button size="sm" variant="outline" onClick={run(rejectMatch)} disabled={pending} className="px-3 text-slate-600">
        <X />
        Reject
      </Button>
      {error && <span role="alert" className="basis-full text-right text-xs text-destructive">{error}</span>}
    </div>
  );
}
